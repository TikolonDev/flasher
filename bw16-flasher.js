const ACK = 0x06;
const NAK = 0x15;
const CMD_WRITE = 0x02;
const CMD_RESET = 0x04;
const CMD_XMODEM = 0x07;
const CMD_ERASE = 0x17;
const CMD_FLASH_MODE = 0x26;
const FLASHLOADER_ADDRESS = 0x082000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class RealtekSerial {
  constructor(log) {
    this.log = log;
    this.bytes = [];
    this.waiters = [];
  }

  async connect() {
    if (!('serial' in navigator)) throw new Error('Web Serial is unavailable. Use Chrome or Edge.');
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.readTask = this.readLoop();
  }

  async readLoop() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        for (const byte of value) this.push(byte);
      }
    } catch (error) {
      if (this.port) this.log(`Serial reader stopped: ${error.message}`);
    }
  }

  push(byte) {
    const waiter = this.waiters.find((candidate) => candidate.matches(byte));
    if (waiter) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(byte);
      return;
    }
    this.bytes.push(byte);
    if (this.bytes.length > 8192) this.bytes.splice(0, this.bytes.length - 8192);
  }

  async waitFor(matches, timeout = 5000) {
    const queued = this.bytes.findIndex(matches);
    if (queued !== -1) return this.bytes.splice(queued, 1)[0];
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve: (byte) => { clearTimeout(timer); resolve(byte); } };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error('Timed out waiting for the BW16 bootloader. Hold BURN, tap RST, then release BURN after two seconds.'));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  async waitForNak() { return this.waitFor((byte) => byte === NAK); }
  async waitForAck() { return this.waitFor((byte) => byte === ACK); }
  async write(bytes) { await this.writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }

  async enterDownloadMode() {
    await this.port.setSignals({ requestToSend: true, dataTerminalReady: false });
    await delay(500);
    await this.port.setSignals({ requestToSend: false, dataTerminalReady: true });
    await delay(200);
    await this.port.setSignals({ requestToSend: false, dataTerminalReady: false });
    await delay(500);
  }

  async command(command) {
    if (command[0] !== CMD_XMODEM) await this.waitForNak();
    await this.write(command);
    await this.waitForAck();
  }

  async writeBlock(address, source, sequence, onProgress) {
    const blocks = Math.ceil(source.length / 1024);
    const image = new Uint8Array(blocks * 1024).fill(0xff);
    image.set(source);
    await this.waitForNak();
    for (let block = 0; block < blocks; block += 1) {
      const packet = new Uint8Array(1032);
      packet[0] = CMD_WRITE;
      packet[1] = sequence.value & 0xff;
      packet[2] = (~sequence.value) & 0xff;
      new DataView(packet.buffer).setUint32(3, address + (block * 1024), true);
      packet.set(image.subarray(block * 1024, (block + 1) * 1024), 7);
      let checksum = 0;
      for (let index = 0; index < 1031; index += 1) checksum = (checksum + packet[index]) & 0xff;
      packet[1031] = checksum;
      await this.write(packet);
      await this.waitForAck();
      sequence.value += 1;
      onProgress(block + 1, blocks);
    }
  }

  async close() {
    try { await this.reader.cancel(); } catch { /* already closed */ }
    try { this.reader.releaseLock(); } catch { /* already released */ }
    try { this.writer.releaseLock(); } catch { /* already released */ }
    try { await this.port.close(); } catch { /* already closed */ }
    this.port = null;
  }
}

const fetchBinary = async (path) => {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not download ${path}.`);
  return new Uint8Array(await response.arrayBuffer());
};

export async function flashBw16({ log, progress }) {
  const serial = new RealtekSerial(log);
  try {
    log('Select the BW16 serial port.');
    await serial.connect();
    log('Entering Realtek download mode…');
    await serial.enterDownloadMode();
    await serial.waitForNak();
    await serial.waitForNak();
    log('Realtek ROM bootloader detected. Downloading firmware files…');
    const [flashloader, km0, km4, application] = await Promise.all([
      fetchBinary('./firmware/bw16/imgtool_flashloader_amebad.bin'),
      fetchBinary('./firmware/bw16/km0_boot_all.bin'),
      fetchBinary('./firmware/bw16/km4_boot_all.bin'),
      fetchBinary('./firmware/bw16/bw16.bin'),
    ]);

    const sequence = { value: 1 };
    progress(2, 'Loading the Realtek flashloader…');
    await serial.writeBlock(FLASHLOADER_ADDRESS, flashloader, sequence, () => {});
    await serial.command([CMD_RESET]);
    await serial.waitForNak();
    await serial.waitForNak();
    await serial.command([CMD_FLASH_MODE, 0x01, 0x01, 0x00]);

    const images = [
      { address: 0x08000000, data: km0, name: 'KM0 boot image' },
      { address: 0x08004000, data: km4, name: 'KM4 boot image' },
      { address: 0x08006000, data: application, name: 'application firmware' },
    ];
    for (const image of images) {
      const sectors = Math.ceil(image.data.length / 4096);
      const erase = new Uint8Array(6);
      erase[0] = CMD_ERASE;
      new DataView(erase.buffer).setUint32(1, image.address, true);
      new DataView(erase.buffer).setUint16(4, sectors, true);
      await serial.command(erase);
    }
    await serial.waitForNak();
    await serial.command([CMD_XMODEM]);
    await serial.waitForNak();

    let completed = 0;
    const total = images.reduce((sum, image) => sum + Math.ceil(image.data.length / 1024), 0);
    for (const image of images) {
      log(`Writing ${image.name}…`);
      await serial.writeBlock(image.address, image.data, sequence, (written) => {
        progress(10 + Math.round((100 * (completed + written)) / total * 0.88), `Writing ${image.name}…`);
      });
      completed += Math.ceil(image.data.length / 1024);
    }
    await serial.command([CMD_RESET]);
    await serial.port.setSignals({ requestToSend: true, dataTerminalReady: false });
    await delay(500);
    await serial.port.setSignals({ requestToSend: false, dataTerminalReady: false });
    progress(100, 'BW16 firmware flashed successfully.');
    log('Finished. The board has been restarted.');
  } finally {
    await serial.close();
  }
}
