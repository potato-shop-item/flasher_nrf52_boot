// @ts-ignore
import {
  requestSerialPort,
  requestXiaoBootloaderPort
} from "./webusb-serial.js";
import { AdafruitDFU } from "./adafruit-dfu.js";

const baudrates = document.getElementById("baudrates") as HTMLSelectElement;
const connectButton = document.getElementById("connectButton") as HTMLButtonElement;
const disconnectButton = document.getElementById("disconnectButton") as HTMLButtonElement;
const eraseButton = document.getElementById("eraseButton") as HTMLButtonElement;
const programButton = document.getElementById("programButton");
const filesDiv = document.getElementById("files");
const terminal = document.getElementById("terminal");
const programDiv = document.getElementById("program");
const lblBaudrate = document.getElementById("lblBaudrate");
const lblConnTo = document.getElementById("lblConnTo");
const table = document.getElementById("fileTable") as HTMLTableElement;
const alertDiv = document.getElementById("alertDiv");

import {
  ESPLoader,
  FlashOptions,
  FlashModeValues,
  FlashFreqValues,
  FlashSizeValues,
  LoaderOptions,
  Transport,
} from "../../../lib";
import { serial } from "web-serial-polyfill";

const serialLib = !navigator.serial && navigator.usb ? serial : navigator.serial;

declare let Terminal; 
declare let CryptoJS; 
declare let JSZip;

// 縦幅を15行に固定し、自動改行お任せモードをONにしたターミナル初期化
const term = new Terminal({ 
  cols: 100, 
  rows: 15, 
  convertEol: true 
});
term.open(terminal);

let device = null;
let deviceInfo = null;
let transport: Transport;
let chip: string = null;
let esploader: ESPLoader;

// 初期状態のUI制御
disconnectButton.style.display = "none";
eraseButton.style.display = "none";
filesDiv.style.display = "block";

// Bootloader更新版ではProgramボタンをメイン操作ボタンとして使用
(programButton as HTMLButtonElement).textContent = "Bootloaderを更新";
connectButton.style.display = "none";

function handleFileSelect(evt) {
  const file = evt.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev: ProgressEvent<FileReader>) => {
    if (ev.target.result instanceof ArrayBuffer) {
      evt.target.data = new Uint8Array(ev.target.result);
    } else {
      evt.target.data = ev.target.result;
    }
  };
  reader.readAsArrayBuffer(file);
}

const espLoaderTerminal = {
  clean() {
    term.clear();
  },
  writeLine(data) {
    term.writeln(data);
  },
  write(data) {
    term.write(data);
  },
};

function createFileInputRow() {
  const rowCount = table.rows.length;
  const row = table.insertRow(rowCount);

  const cell1 = row.insertCell(0);
  const element1 = document.createElement("input");
  element1.type = "file";
  element1.accept = ".zip";
  element1.id = "selectFile" + rowCount;
  element1.name = "selected_File" + rowCount;
  element1.addEventListener("change", handleFileSelect, false);
  cell1.appendChild(element1);

  const cell2 = row.insertCell(1);
  cell2.classList.add("progress-cell");
  cell2.style.display = "none";
  cell2.innerHTML = `<progress value="0" max="100"></progress>`;
}

// ----------------------------------------------------
// 1. Program (書き込み) ロジック
// ----------------------------------------------------
connectButton.onclick = async () => {
  try {
    device = await requestSerialPort(true);
    deviceInfo = device.getInfo();

    const vid = deviceInfo.usbVendorId;
    const pid = deviceInfo.usbProductId;

    term.writeln(
      `USB device: VID=0x${vid.toString(16).padStart(4, "0")} ` +
      `PID=0x${pid.toString(16).padStart(4, "0")}`
    );

    if (vid !== 0x2886 || pid !== 0x0045) {
      term.writeln("ERROR: XIAO nRF52840 Bootloaderではありません");
      term.writeln(
        "RESETを素早く2回押してBootloaderモードにしてください"
      );
      return;
    }

    term.writeln("XIAO nRF52840 Bootloader detected");
    term.writeln("Opening serial port...");

    await device.open({
      baudRate: 115200
    });

    term.writeln("Serial port opened successfully");
    term.writeln("Toggling DTR...");

    await device.setSignals({
      dataTerminalReady: false,
      requestToSend: false
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    await device.setSignals({
      dataTerminalReady: true,
      requestToSend: false
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    term.writeln("==============================");
    term.writeln("XIAO nRF52840 CONNECTED");
    term.writeln("Ready for Bootloader 0.11.0 update.");
    term.writeln("==============================");

    // ファイル選択欄を表示
    filesDiv.style.display = "block";
    programDiv.style.display = "block";

    // 接続後のUI
    lblBaudrate.style.display = "none";
    baudrates.style.display = "none";
    connectButton.style.display = "none";
    disconnectButton.style.display = "initial";

    lblConnTo.innerHTML =
      "Connected: XIAO nRF52840 Bootloader";

    lblConnTo.style.display = "block";

  } catch (e) {
    console.error(e);
    term.writeln(`ERROR: ${e.message}`);
  }
};

eraseButton.onclick = async () => {
  eraseButton.disabled = true;
  try {
    await esploader.eraseFlash();
  } catch (e) {
    console.error(e);
    term.writeln(`Error: ${e.message}`);
  } finally {
    eraseButton.disabled = false;
  }
};

function cleanUp() {
  device = null;
  deviceInfo = null;
  transport = null;
  chip = null;
}

disconnectButton.onclick = async () => {
  if (transport) await transport.disconnect();

  term.reset();
  lblBaudrate.style.display = "initial";
  baudrates.style.display = "initial";
  connectButton.style.display = "initial";
  disconnectButton.style.display = "none";
  eraseButton.style.display = "none";
  lblConnTo.style.display = "none";
  filesDiv.style.display = "block";
  alertDiv.style.display = "none";
  cleanUp();
};

// ----------------------------------------------------
// 2. 共通プログラム検証
// ----------------------------------------------------
function validateProgramInputs() {
  const rowCount = table.rows.length;
  let row;
  let fileData = null;

  for (let index = 0; index < rowCount; index++) {
    row = table.rows[index];
    if (!row.cells[0] || !row.cells[0].childNodes[0]) return "No file field available!";
    const fileObj = row.cells[0].childNodes[0] as any;
    fileData = fileObj.data;
    if (fileData == null) return "No file selected!";
  }
  return "success";
}

programButton.onclick = async () => {

  // 二重押し防止
  (programButton as HTMLButtonElement).disabled = true;

  let progressBar: HTMLProgressElement | null = null;
  let progressRow: HTMLTableRowElement | null = null;
  let writeCompleted = false;

  try {
    alertDiv.style.display = "none";

    // ----------------------------------------------------
    // USB選択 → XIAO Bootloader接続を自動実行
    // ----------------------------------------------------
    term.reset();
    term.writeln("==============================");
    term.writeln("XIAO nRF52840 Bootloader Update 0.16");
    term.writeln("==============================");
    term.writeln("Select XIAO nRF52840 Bootloader USB device.");

    device = await requestSerialPort(true);

    deviceInfo = device.getInfo();

    const vid = deviceInfo.usbVendorId;
    const pid = deviceInfo.usbProductId;

    term.writeln(
      `USB device: VID=0x${vid.toString(16).padStart(4, "0")} ` +
      `PID=0x${pid.toString(16).padStart(4, "0")}`
    );

    if (vid !== 0x2886 || pid !== 0x0045) {
      throw new Error(
        "XIAO nRF52840 Bootloaderではありません。RESETを素早く2回押してBootloaderモードにしてください。"
      );
    }

    // ----------------------------------------------------
    // カスタム署名版Bootloaderがすでに入っているか確認
    // WebUSBSerial.getInfo() から取得
    // ----------------------------------------------------
/*
    const productName = deviceInfo.productName || "";

    term.writeln("USB Product: " + (productName || "(unknown)"));

    if (productName === "XIAO nRF52840 Secure") {
      term.writeln("==============================");
      term.writeln("Bootloaderは更新済みです。");
      term.writeln("更新の必要はありません。");
      term.writeln("==============================");

      writeCompleted = true;
      return;
    }
*/


    term.writeln("XIAO nRF52840 Bootloader detected");
    term.writeln("Opening serial port...");

    await device.open({
      baudRate: 115200
    });

    term.writeln("Serial port opened successfully");
    term.writeln("Toggling DTR...");

    await device.setSignals({
      dataTerminalReady: false,
      requestToSend: false
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    await device.setSignals({
      dataTerminalReady: true,
      requestToSend: false
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    term.writeln("==============================");
    term.writeln("XIAO nRF52840 CONNECTED");
    term.writeln("Starting Bootloader update automatically.");
    term.writeln("==============================");

    // 接続後のUI
    lblBaudrate.style.display = "none";
    baudrates.style.display = "none";
    connectButton.style.display = "none";
    disconnectButton.style.display = "initial";
    filesDiv.style.display = "block";
    programDiv.style.display = "block";

    lblConnTo.innerHTML =
      "Connected: XIAO nRF52840 Bootloader";
    lblConnTo.style.display = "block";

    // ----------------------------------------------------
    // Bootloader Update ZIPをサーバーから取得
    // ----------------------------------------------------
    const bootloaderZipUrl =
      "./firmware/xiao_nrf52840_ble_bootloader-0.11.0-dirty_s140_7.3.0.zip";

    term.writeln("==============================");
    term.writeln("BOOTLOADER UPDATE FILE");
    term.writeln("==============================");
    term.writeln("Downloading Bootloader Update ZIP...");

    const response = await fetch(bootloaderZipUrl, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(
        `Bootloader ZIP download failed: HTTP ${response.status}`
      );
    }

    const zipData = await response.arrayBuffer();

    if (zipData.byteLength === 0) {
      throw new Error("Bootloader ZIP is empty.");
    }

    term.writeln(
      "ZIP downloaded: " +
      zipData.byteLength +
      " bytes"
    );

    const zip = await JSZip.loadAsync(zipData);

    term.writeln("Bootloader ZIP loaded.");

    // ----------------------------------------------------
    // manifest.json
    // ----------------------------------------------------
    const manifestEntry = zip.file("manifest.json");

    if (!manifestEntry) {
      throw new Error("manifest.json not found.");
    }

    const manifestText = await manifestEntry.async("text");
    const manifest = JSON.parse(manifestText);

    const sdBootloader =
      manifest?.manifest?.softdevice_bootloader;

    if (!sdBootloader) {
      throw new Error(
        "softdevice_bootloader entry not found in manifest.json"
      );
    }

    const binFileName = sdBootloader.bin_file;
    const datFileName = sdBootloader.dat_file;

    if (!binFileName || !datFileName) {
      throw new Error(
        "bin_file/dat_file not found in manifest.json"
      );
    }

    const softdeviceSize = Number(sdBootloader.sd_size);
    const bootloaderSize = Number(sdBootloader.bl_size);

    if (!Number.isInteger(softdeviceSize) || softdeviceSize <= 0) {
      throw new Error("Invalid sd_size in manifest.json");
    }

    if (!Number.isInteger(bootloaderSize) || bootloaderSize <= 0) {
      throw new Error("Invalid bl_size in manifest.json");
    }

    term.writeln("BIN from manifest: " + binFileName);
    term.writeln("DAT from manifest: " + datFileName);
    term.writeln("SoftDevice size: " + softdeviceSize + " bytes");
    term.writeln("Bootloader size: " + bootloaderSize + " bytes");

    // ----------------------------------------------------
    // BIN / DAT取得
    // ----------------------------------------------------
    const binEntry = zip.file(binFileName);
    if (!binEntry) {
      throw new Error(
        "BIN file not found: " + binFileName
      );
    }

    const datEntry = zip.file(datFileName);
    if (!datEntry) {
      throw new Error(
        "DAT file not found: " + datFileName
      );
    }

    const firmware = await binEntry.async("uint8array");
    const initPacket = await datEntry.async("uint8array");

    term.writeln(
      "BIN size: " +
      firmware.length +
      " bytes"
    );

    term.writeln(
      "DAT size: " +
      initPacket.length +
      " bytes"
    );

    // SD + BL のサイズをmanifestとBIN実サイズで照合
    const expectedFirmwareSize =
      softdeviceSize + bootloaderSize;

    if (firmware.length !== expectedFirmwareSize) {
      throw new Error(
        `SD+BL size mismatch: BIN=${firmware.length}, ` +
        `manifest=${expectedFirmwareSize}`
      );
    }

    term.writeln("==============================");
    term.writeln("Bootloader update file verified.");
    term.writeln("==============================");

    // ----------------------------------------------------
    // プログレスバー
    // ----------------------------------------------------
    progressRow = table.rows[0];

    progressBar =
      progressRow.cells[1].querySelector("progress") as HTMLProgressElement;

    if (!progressBar) {
      throw new Error("Progress bar not found.");
    }

    progressRow.cells[1].style.display = "initial";
    progressBar.value = 0;

    term.writeln("");
    term.writeln("==============================");
    term.writeln("Starting Bootloader DFU");
    term.writeln("==============================");

    const dfu = new AdafruitDFU(
      device,
      (msg) => term.writeln(msg)
    );

    try {

      await dfu.start();
/*
      const bootloaderIdentity =
        await dfu.identifySecureBootloader();

      console.log("bootloaderIdentity =", bootloaderIdentity);
      if (
        bootloaderIdentity.response === "payload" &&
        bootloaderIdentity.text === "SECURE"
      ) {
        term.writeln("==============================");
        term.writeln("Bootloaderは更新済みです。");
        term.writeln("更新の必要はありません。");
        term.writeln("==============================");

        writeCompleted = true;
        return;
      }
*/


      // ------------------------------------------------
      // START: SoftDevice + Bootloader
      // ------------------------------------------------
      term.writeln("Sending DFU START...");
    
      await dfu.sendStartDfu(
        3,
        softdeviceSize,
        bootloaderSize,
        0
      );

      term.writeln("DFU START OK");

      // ------------------------------------------------
      // Flash erase wait
      // ------------------------------------------------
      const eraseWaitMs =
        Math.max(
          500,
          (Math.floor(firmware.length / 4096) + 1)
            * 89.7
        );

      term.writeln(
        "Waiting for flash erase: " +
        Math.ceil(eraseWaitMs) +
        " ms"
      );

      await new Promise(
        resolve => setTimeout(resolve, eraseWaitMs)
      );

      // ------------------------------------------------
      // INIT
      // ------------------------------------------------
      term.writeln("Sending INIT packet...");

      await dfu.sendInitPacket(initPacket);

      term.writeln("INIT OK");

      // ------------------------------------------------
      // Firmware DATA
      // ------------------------------------------------
      term.writeln("Sending SoftDevice + Bootloader DATA...");

      let lastPercent = -1;

      await dfu.sendFirmware(
        firmware,
        (written, total) => {
          const percent =
            Math.floor((written / total) * 100);

          progressBar.value = percent;

          if (
            percent >= lastPercent + 10 ||
            percent === 100
          ) {
            lastPercent = percent;

            term.writeln(
              `DFU DATA: ${written}/${total} ` +
              `bytes (${percent}%)`
            );
          }
        }
      );

      term.writeln("FIRMWARE DATA OK");

      // ------------------------------------------------
      // STOP
      // ------------------------------------------------
      term.writeln("Sending DFU STOP...");

      await dfu.sendStopDataPacket();

      term.writeln("DFU STOP OK");

      term.writeln("==============================");
      term.writeln("Bootloader Update Complete");
      term.writeln("==============================");

      writeCompleted = true;
      progressBar.value = 100;

      await new Promise(resolve => setTimeout(resolve, 500));

      progressRow.cells[1].style.display = "none";

    } finally {
      await dfu.stop();
    }

  } catch (e) {
    console.error(e);
    term.writeln(`ERROR: ${e.message}`);

  } finally {
    if (!writeCompleted && progressRow) {
      progressRow.cells[1].style.display = "none";
    }

    (programButton as HTMLButtonElement).disabled = false;
  }
};

function createBootloaderProgressRow() {
  const row = table.insertRow(table.rows.length);

  const cell1 = row.insertCell(0);
  cell1.textContent =
    "Bootloader 0.11.0 update file will be downloaded automatically.";

  const cell2 = row.insertCell(1);
  cell2.classList.add("progress-cell");
  cell2.style.display = "none";
  cell2.innerHTML = `<progress value="0" max="100"></progress>`;
}

createBootloaderProgressRow();