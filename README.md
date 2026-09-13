# TKL Nova-X Firmware Flasher

This is a static GitHub Pages site for the two fixed TKL Nova-X firmware builds:

- ESP32-C5: browser installation through ESP Web Tools and Web Serial.
- BW16: a browser-based Realtek UART installer, a compiled RTL8720DN image, and its required Realtek boot files.

## Publish with GitHub Pages

1. Create a GitHub repository and copy this folder to its root.
2. Commit and push the files to the `main` branch.
3. In **Settings → Pages**, choose **Deploy from a branch**, then select `main` and `/(root)`.

The ESP32-C5 installer requires Chrome or Microsoft Edge with Web Serial enabled. It uses the merged `firmware/esp32-c5.bin` image at flash offset `0x0`.

## BW16 firmware

`firmware/bw16/bw16.bin` was compiled for `realtek:AmebaD:Ai-Thinker_BW16` with AmebaD core 3.1.9. The image is `km0_km4_image2.bin`, the format produced by the Realtek Arduino uploader. The accompanying `km0_boot_all.bin`, `km4_boot_all.bin`, and `imgtool_flashloader_amebad.bin` are required by the Realtek upload workflow.

The BW16 installer uses the Realtek ROM download protocol through Web Serial. It automatically enters download mode, loads the temporary flashloader, erases the required sectors, writes the three fixed images, and restarts the board. Do not disconnect the board while flashing. The ESP32 installer must never be used for BW16 boards.
