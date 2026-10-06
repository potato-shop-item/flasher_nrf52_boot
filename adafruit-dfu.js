// adafruit-dfu.js
//
// Adafruit nRF52 legacy Serial DFU transport
// First test: HCI/SLIP packet -> ACK

const SLIP_END     = 0xC0;
const SLIP_ESC     = 0xDB;
const SLIP_ESC_END = 0xDC;
const SLIP_ESC_ESC = 0xDD;

const DATA_INTEGRITY_CHECK_PRESENT = 1;
const RELIABLE_PACKET = 1;
const HCI_PACKET_TYPE = 14;

let sequenceNumber = 0;


// ------------------------------------------------------------
// 32bit little-endian変換〠
// ------------------------------------------------------------
function int32LE(value) {

    return [
        value & 0xFF,
        (value >>> 8) & 0xFF,
        (value >>> 16) & 0xFF,
        (value >>> 24) & 0xFF
    ];
}

// ------------------------------------------------------------
// HCI header
// Equivalent to nrfutil slip_parts_to_four_bytes()
// ------------------------------------------------------------
function makeHeader(seq, dip, rp, packetType, packetLength) {

    const h = new Uint8Array(4);

    h[0] =
        (seq & 0x07) |
        (((seq + 1) % 8) << 3) |
        ((dip & 1) << 6) |
        ((rp & 1) << 7);

    h[1] =
        (packetType & 0x0F) |
        ((packetLength & 0x000F) << 4);

    h[2] =
        (packetLength & 0x0FF0) >> 4;

    h[3] =
        (~(h[0] + h[1] + h[2]) + 1) & 0xFF;

    return h;
}


// ------------------------------------------------------------
// CRC16 used by Nordic legacy DFU
// CRC-16/CCITT reflected
// poly = 0x8408
// initial = 0xffff
// ------------------------------------------------------------
function crc16(data) {

    let crc = 0xFFFF;

    for (const byte of data) {

        crc = ((crc >> 8) | (crc << 8)) & 0xFFFF;
        crc ^= byte;
        crc ^= (crc & 0xFF) >> 4;
        crc ^= (crc << 12) & 0xFFFF;
        crc ^= ((crc & 0xFF) << 5) & 0xFFFF;

        crc &= 0xFFFF;
    }

    return crc;
}


// ------------------------------------------------------------
// SLIP escape
// ------------------------------------------------------------
function slipEncode(data) {

    const out = [SLIP_END];

    for (const b of data) {

        if (b === SLIP_END) {
            out.push(SLIP_ESC, SLIP_ESC_END);

        } else if (b === SLIP_ESC) {
            out.push(SLIP_ESC, SLIP_ESC_ESC);

        } else {
            out.push(b);
        }
    }

    out.push(SLIP_END);

    return new Uint8Array(out);
}


// ------------------------------------------------------------
// SLIP decode
// ------------------------------------------------------------
function slipDecode(data) {

    const out = [];

    for (let i = 0; i < data.length; i++) {

        const b = data[i];

        if (b === SLIP_END)
            continue;

        if (b === SLIP_ESC) {

            i++;

            if (i >= data.length)
                break;

            if (data[i] === SLIP_ESC_END) {
                out.push(SLIP_END);

            } else if (data[i] === SLIP_ESC_ESC) {
                out.push(SLIP_ESC);

            } else {
                throw new Error("Invalid SLIP escape");
            }

        } else {
            out.push(b);
        }
    }

    return new Uint8Array(out);
}


// ------------------------------------------------------------
// Build HCI packet
// ------------------------------------------------------------
function buildHciPacket(payload) {

    sequenceNumber = (sequenceNumber + 1) % 8;

    const header = makeHeader(
        sequenceNumber,
        DATA_INTEGRITY_CHECK_PRESENT,
        RELIABLE_PACKET,
        HCI_PACKET_TYPE,
        payload.length
    );

    const raw = new Uint8Array(
        header.length + payload.length
    );

    raw.set(header, 0);
    raw.set(payload, 4);

    const crc = crc16(raw);

    const withCRC = new Uint8Array(raw.length + 2);

    withCRC.set(raw, 0);

    // Nordic implementation sends CRC little endian
    withCRC[raw.length]     = crc & 0xFF;
    withCRC[raw.length + 1] = (crc >> 8) & 0xFF;

    return {
        sequence: sequenceNumber,
        packet: slipEncode(withCRC)
    };
}


// ------------------------------------------------------------

export class AdafruitDFU {

    constructor(port, logger = console.log) {

        this.port = port;
        this.log = logger;

        this.reader = null;
        this.writer = null;
    }


    async start() {

        sequenceNumber = 0;

        this.reader = this.port.readable.getReader();
        this.writer = this.port.writable.getWriter();

        this.log("[DFU] Adafruit HCI transport ready");
    }


    async stop() {

        if (this.reader) {

            try {
                await this.reader.cancel();
            } catch (_) {}

            this.reader.releaseLock();
            this.reader = null;
        }

        if (this.writer) {
            this.writer.releaseLock();	
            this.writer = null;
        }
    }


    hex(data) {

        return Array.from(data)
            .map(v => v.toString(16).padStart(2, "0"))
            .join(" ");
    }


    async readAck(timeoutMs = 1500, verbose = true) {

        const received = [];
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {

            const remaining = deadline - Date.now();

            let result;

            try {

                result = await Promise.race([

                    this.reader.read(),

                    new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error("ACK timeout")),
                            remaining
                        )
                    )
                ]);

            } catch (e) {

                throw new Error("ACK timeout");
            }

            if (result.done)
                throw new Error("Serial stream closed");

            for (const b of result.value) {

                received.push(b);

                // nrfutil waits until two C0 delimiters exist
                const endCount =
                    received.filter(v => v === SLIP_END).length;

                if (endCount >= 2) {

                    const frame = new Uint8Array(received);

                    if (verbose) {
                        this.log(
                            "[DFU RX RAW] " + this.hex(frame)
                        );
                    }

                    const decoded = slipDecode(frame);

                    if (verbose) {
                        this.log(
                            "[DFU RX] " + this.hex(decoded)
                        );
                    }

                    if (decoded.length < 1)
                        throw new Error("Invalid ACK packet");

                    const ack =
                        (decoded[0] >> 3) & 0x07;

                    if (verbose) {
                        this.log(
                            "[DFU] ACK sequence = " + ack
                        );
                    }

                    return ack;
                }
            }
        }

        throw new Error("ACK timeout");
    }

    // --------------------------------------------------------
    // Read one HCI application packet after the transport ACK.
    // Used by Secure Bootloader IDENTIFY command.
    // --------------------------------------------------------
    async readResponsePacket(timeoutMs = 1000) {

        const received = [];
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {

            const remaining = deadline - Date.now();

            let result;

            try {

                result = await Promise.race([
                    this.reader.read(),

                    new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error("Response timeout")),
                            remaining
                        )
                    )
                ]);

            } catch (e) {
                throw new Error("Response timeout");
            }

            if (result.done) {
                throw new Error("Serial stream closed");
            }

            for (const b of result.value) {

                received.push(b);

                const endCount =
                    received.filter(v => v === SLIP_END).length;

                if (endCount >= 2) {

                    const frame =
                        new Uint8Array(received);

                    const decoded =
                        slipDecode(frame);

                    // HCI header = 4 bytes
                    // CRC        = 2 bytes
                    if (decoded.length < 6) {
                        throw new Error(
                            "Invalid response packet"
                        );
                    }

                    const header0 = decoded[0];

                    const packetLength =
                        ((decoded[1] >> 4) & 0x0F) |
                        (decoded[2] << 4);

                    if (
                        decoded.length <
                        4 + packetLength + 2
                    ) {
                        throw new Error(
                            "Incomplete response packet"
                        );
                    }

                    const payload =
                        decoded.slice(
                            4,
                            4 + packetLength
                        );

                    // ACK the reliable packet from the Bootloader.
                    const rxSequence =
                        header0 & 0x07;

                    const nextSequence =
                        (rxSequence + 1) % 8;

                    const ackHeader =
                        makeHeader(
                            0,
                            0,
                            0,
                            1,
                            0
                        );

                    ackHeader[0] =
                        (ackHeader[0] & 0xC7) |
                        (nextSequence << 3);

                    ackHeader[3] =
                        (~(
                            ackHeader[0] +
                            ackHeader[1] +
                            ackHeader[2]
                        ) + 1) & 0xFF;

                    const ackFrame =
                        slipEncode(ackHeader);

                    await this.writer.write(ackFrame);

                    return payload;
                }
            }
        }

        throw new Error("Response timeout");
    }

    // --------------------------------------------------------
    // Transport-only test
    //
    // Sends an empty reliable HCI packet.
    // We are testing HCI ACK only.
    // --------------------------------------------------------
    async testAck() {

        const payload = new Uint8Array(0);

        const built = buildHciPacket(payload);

        this.log(
            "[DFU] TX sequence = " + built.sequence
        );

        this.log(
            "[DFU TX RAW] " + this.hex(built.packet)
        );

        await this.writer.write(built.packet);

        const ack = await this.readAck();

        const expectedAck = (built.sequence + 1) % 8;

        if (ack !== expectedAck) {

            throw new Error(
                `ACK mismatch: TX=${built.sequence}, ` +
                `expected=${expectedAck}, RX=${ack}`
            );
        }

        this.log(
            `[DFU] HCI ACK OK (TX=${built.sequence}, next=${ack})`
        );

        return true;
    }

    // --------------------------------------------------------
    // Secure Bootloader IDENTIFY
    // command = 6
    // --------------------------------------------------------
    async identifySecureBootloader() {

        const payload = new Uint8Array(
            int32LE(6)
        );

        const built = buildHciPacket(payload);

        this.log(
            "[DFU] Checking Bootloader version..."
        );

        await this.writer.write(built.packet);

        try {

            const ack = await this.readAck(2000);

            const expectedAck =
                (built.sequence + 1) % 8;

            if (ack !== expectedAck) {
                throw new Error(
                    `command 6 ACK mismatch: expected=${expectedAck}, RX=${ack}`
                );
            }

            try {

                const payload =
                    await this.readResponsePacket(1500);

                const text =
                    new TextDecoder().decode(payload);

                this.log(
                    `[DFU] Bootloader identify response: "${text}"`
                );

                return {
                    response: "payload",
                    ack,
                    expectedAck,
                    text
                };

            } catch (e) {

                // Android/WebUSB:
                // readerはキャンセル・再取得しない
                return {
                    response: "ack-only",
                    ack,
                    expectedAck
                };
            }

        } catch (e) {

            this.log(
                "[DFU TEST] command 6 response: " +
                e.message
            );

            return {
                response: "timeout",
                error: e.message
            };
        }
    }

    async sendStartDfu(
        mode,
        softdeviceSize,
        bootloaderSize,
        applicationSize
    ) {
        const payload = new Uint8Array([
            ...int32LE(3),
            ...int32LE(mode),
            ...int32LE(softdeviceSize),
            ...int32LE(bootloaderSize),
            ...int32LE(applicationSize)
        ]);

        this.log(
            "[DFU] START payload: " + this.hex(payload)
        );

        const built = buildHciPacket(payload);

        this.log(
            "[DFU] START TX sequence = " + built.sequence
        );

        this.log(
            "[DFU START TX RAW] " + this.hex(built.packet)
        );

        await this.writer.write(built.packet);

        const ack = await this.readAck(3000);

        const expectedAck = (built.sequence + 1) % 8;

        if (ack !== expectedAck) {
            throw new Error(
                `START ACK mismatch: TX=${built.sequence}, ` +
                `expected=${expectedAck}, RX=${ack}`
            );
        }

        this.log(
            `[DFU] START ACK OK (TX=${built.sequence}, next=${ack})`
        );

        return true;
    }

    async sendInitPacket(initPacket) {

        const payload = new Uint8Array(
            4 + initPacket.length + 2
        );

        // DFU_INIT_PACKET = 1
        payload.set(int32LE(1), 0);

        // Signed .dat
        payload.set(initPacket, 4);

        // Required padding
        payload[payload.length - 2] = 0x00;
        payload[payload.length - 1] = 0x00;

        this.log(
            "[DFU] INIT size = " + initPacket.length
        );

        this.log(
            "[DFU] INIT payload size = " + payload.length
        );

        this.log(
            "[DFU] INIT payload: " + this.hex(payload)
        );

        const built = buildHciPacket(payload);

        this.log(
            "[DFU] INIT TX sequence = " + built.sequence
        );

        this.log(
            "[DFU INIT TX RAW] " + this.hex(built.packet)
        );

        await this.writer.write(built.packet);

        const ack = await this.readAck(3000);

        const expectedAck = (built.sequence + 1) % 8;

        if (ack !== expectedAck) {
            throw new Error(
                `INIT ACK mismatch: TX=${built.sequence}, ` +
                `expected=${expectedAck}, RX=${ack}`
            );
        }

        this.log(
            `[DFU] INIT ACK OK (TX=${built.sequence}, next=${ack})`
        );

        return true;
    }

    async sendDataPacket(data) {

        if (data.length > 512) {
            throw new Error(
                "DFU DATA chunk too large: " + data.length
            );
        }

        const payload = new Uint8Array(
            4 + data.length
        );

        // DFU_DATA_PACKET = 4
        payload.set(int32LE(4), 0);

        // Firmware data
        payload.set(data, 4);

        const built = buildHciPacket(payload);

        await this.writer.write(built.packet);

        const ack = await this.readAck(3000, false);

        const expectedAck =
            (built.sequence + 1) % 8;

        if (ack !== expectedAck) {
            throw new Error(
                `DATA ACK mismatch: TX=${built.sequence}, ` +
                `expected=${expectedAck}, RX=${ack}`
            );
        }

        return true;
    }

    async sendFirmware(firmware, progressCallback = null) {

        const CHUNK_SIZE = 512;
        const PAGE_PACKET_COUNT = 8;
        const PAGE_WRITE_WAIT_MS = 103;

        const totalPackets =
            Math.ceil(firmware.length / CHUNK_SIZE);

        this.log(
            `[DFU] Firmware size = ${firmware.length} bytes`
        );

        this.log(
            `[DFU] Total DATA packets = ${totalPackets}`
        );

        let packetCount = 0;

        for (
            let offset = 0;
            offset < firmware.length;
            offset += CHUNK_SIZE
        ) {

            const end = Math.min(
                offset + CHUNK_SIZE,
                firmware.length
            );

            const chunk = firmware.slice(offset, end);

            await this.sendDataPacket(chunk);

            packetCount++;

            if (progressCallback) {
                progressCallback(
                    end,
                    firmware.length
                );
            }

            // Same pacing as nrfutil:
            // wait after every 8 DATA packets
            if (
                packetCount % PAGE_PACKET_COUNT === 0
            ) {
                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            PAGE_WRITE_WAIT_MS
                        )
                );
            }
        }

        // Final flash write wait
        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    PAGE_WRITE_WAIT_MS
                )
        );

        this.log(
            `[DFU] Firmware DATA complete: ` +
            `${packetCount} packets`
        );

        return true;
    }

    async sendStopDataPacket() {

        // DFU_STOP_DATA_PACKET = 5
        const payload = new Uint8Array(
            int32LE(5)
        );

        this.log("[DFU] Sending STOP DATA packet");

        const built = buildHciPacket(payload);

        this.log(
            "[DFU] STOP TX sequence = " +
            built.sequence
        );

        this.log(
            "[DFU STOP TX RAW] " +
            this.hex(built.packet)
        );

        await this.writer.write(built.packet);

        const ack = await this.readAck(5000);

        const expectedAck =
            (built.sequence + 1) % 8;

        if (ack !== expectedAck) {
            throw new Error(
                `STOP ACK mismatch: TX=${built.sequence}, ` +
                `expected=${expectedAck}, RX=${ack}`
            );
        }

        this.log(
            `[DFU] STOP ACK OK ` +
            `(TX=${built.sequence}, next=${ack})`
        );

        return true;
    }

}