// @ts-ignore
/**
 * WebUSBSerial - Web Serial API-like wrapper for WebUSB
 * Provides a familiar interface for serial communication over USB on Android
 * 
 * This enables to work on Android devices where Web Serial API
 * is not available but WebUSB is supported.
 * 
 * IMPORTANT: For Android compatibility, this class uses smaller transfer sizes
 * to prevent SLIP synchronization errors. The maxTransferSize is set to 64 bytes
 * (or endpoint packetSize if smaller) to ensure SLIP frames don't get split.
 */ class $d3c0f20c363d2d06$export$64a7c750323e1936 {
    constructor(logger = null){
        this.device = null;
        this.interfaceNumber = null;
        this.endpointIn = null;
        this.endpointOut = null;
        this.controlInterface = null;
        this.readableStream = null;
        this.writableStream = null;
        this._readLoopRunning = false;
        this._usbDisconnectHandler = null;
        this._eventListeners = {
            'close': [],
            'disconnect': []
        };
        // Transfer size optimized for WebUSB on Android
        // CRITICAL: blockSize = (maxTransferSize - 2) / 2
        // Set to 64 bytes for maximum compatibility with all USB-Serial adapters
        // With 64 bytes: blockSize = (64-2)/2 = 31 bytes per SLIP packet
        this.maxTransferSize = 64;
        // Flag to indicate this is WebUSB (used by esptool to adjust block sizes)
        this.isWebUSB = true;
        // Command queue for serializing control transfers (critical for CP2102)
        this._commandQueue = Promise.resolve();
        // Track current DTR/RTS state to preserve unspecified signals
        this._currentDTR = false;
        this._currentRTS = false;
        // Logger function (defaults to console.log if not provided)
        this._log = logger || ((...args)=>console.log(...args));
    }
    /**
     * Request USB device (mimics navigator.serial.requestPort())
     * @param {function|object} logger - Logger function or object with log() method
     * @param {boolean} forceNew - If true, forces selection of a new device (ignores already paired devices)
     */ static async requestPort(logger = null, forceNew = false) {
        const filters = [
            {
                vendorId: 0x2886,
                productId: 0x0045
            }
        ];
        // Helper to call logger (supports both function and object with log() method)
        const log = (msg)=>{
            if (!logger) return;
            if (typeof logger === 'function') logger(msg);
            else if (typeof logger.log === 'function') logger.log(msg);
        };
        let device;
        // If forceNew is false, try to reuse a previously authorized device
        if (!forceNew && navigator.usb && navigator.usb.getDevices) try {
            const devices = await navigator.usb.getDevices();
            // Find a device that matches our filters
            device = devices.find((d)=>filters.some((f)=>f.vendorId === d.vendorId));
            if (device) log('[WebUSB] Reusing previously authorized device');
        } catch (err) {
            // Can't use this._log in static method, use console as fallback
            console.warn('[WebUSB] Failed to get previously authorized devices:', err);
        }
        // If no device found or forceNew is true, request a new device
        if (!device) {
            if (!navigator.usb) throw new Error('WebUSB not available');
            device = await navigator.usb.requestDevice({
                filters: filters
            });
        }
        const port = new $d3c0f20c363d2d06$export$64a7c750323e1936(logger);
        port.device = device;
        return port;
    }
    /**
     * Open the USB device (mimics port.open())
     */ async open(options = {}) {
        if (!this.device) throw new Error('No device selected');
        const baudRate = options.baudRate || 115200;
        // If device is already opened, we need to close and reopen it
        // This is critical for ESP32-S2
        if (this.device.opened) try {
            // Release all interfaces
            if (this.interfaceNumber !== null) try {
                await this.device.releaseInterface(this.interfaceNumber);
            } catch (e) {}
            if (this.controlInterface !== null && this.controlInterface !== this.interfaceNumber) try {
                await this.device.releaseInterface(this.controlInterface);
            } catch (e) {}
            // Close the device
            await this.device.close();
            // Reset interface numbers so they get re-scanned
            this.interfaceNumber = null;
            this.controlInterface = null;
            this.endpointIn = null;
            this.endpointOut = null;
            // Wait a bit for device to settle
            await new Promise((resolve)=>setTimeout(resolve, 100));
        } catch (e) {
            this._log('[WebUSB] Error during close:', e.message);
        }
        if (this.device.opened) try {
            await this.device.close();
        } catch (e) {
            this._log('[WebUSB] Error closing device:', e.message);
        }
        try {
            if (this.device.reset) await this.device.reset();
        } catch (e) {
        //            this._log('[WebUSB] Device reset failed:', e.message);
        }
        const attemptOpenAndClaim = async ()=>{
            await this.device.open();
            try {
                const currentCfg = this.device.configuration ? this.device.configuration.configurationValue : null;
                if (!currentCfg || currentCfg !== 1) await this.device.selectConfiguration(1);
            } catch (e) {}
            const config = this.device.configuration;
            // Try to claim CDC control interface first (helps on Android/CH34x)
            const preControlIface = config.interfaces.find((i)=>i.alternates && i.alternates[0] && i.alternates[0].interfaceClass === 0x02);
            if (preControlIface) try {
                await this.device.claimInterface(preControlIface.interfaceNumber);
                try {
                    await this.device.selectAlternateInterface(preControlIface.interfaceNumber, 0);
                } catch (e) {}
                this.controlInterface = preControlIface.interfaceNumber;
            } catch (e) {
                this._log(`[WebUSB] Could not pre-claim CDC control iface: ${e.message}`);
            }
            // Find bulk IN/OUT interface (prefer CDC data class)
            const candidates = [];
            for (const iface of config.interfaces)// Check all alternates, not just alternates[0]
            for(let altIndex = 0; altIndex < iface.alternates.length; altIndex++){
                const alt = iface.alternates[altIndex];
                let hasIn = false, hasOut = false;
                for (const ep of alt.endpoints){
                    if (ep.type === 'bulk' && ep.direction === 'in') hasIn = true;
                    if (ep.type === 'bulk' && ep.direction === 'out') hasOut = true;
                }
                if (hasIn && hasOut) {
                    let score = 2;
                    if (alt.interfaceClass === 0x0a) score = 0; // CDC data first
                    else if (alt.interfaceClass === 0xff) score = 1; // vendor-specific next
                    candidates.push({
                        iface: iface,
                        altIndex: altIndex,
                        alt: alt,
                        score: score
                    });
                    break; // Found suitable alternate for this interface
                }
            }
            if (!candidates.length) throw new Error('No suitable USB interface found');
            candidates.sort((a, b)=>a.score - b.score);
            let lastErr = null;
            for (const cand of candidates)try {
                // CORRECT ORDER per WebUSB spec: claimInterface FIRST, then selectAlternateInterface
                await this.device.claimInterface(cand.iface.interfaceNumber);
                try {
                    await this.device.selectAlternateInterface(cand.iface.interfaceNumber, cand.altIndex);
                } catch (e) {
                    this._log(`[WebUSB] selectAlternateInterface failed: ${e.message}`);
                }
                this.interfaceNumber = cand.iface.interfaceNumber;
                // Use the alternate that was found to have bulk endpoints
                for (const ep of cand.alt.endpoints){
                    if (ep.type === 'bulk' && ep.direction === 'in') this.endpointIn = ep.endpointNumber;
                    else if (ep.type === 'bulk' && ep.direction === 'out') this.endpointOut = ep.endpointNumber;
                }
                // Validate that both endpoints were found
                if (this.endpointIn == null || this.endpointOut == null) throw new Error(`Missing bulk endpoints (in=${this.endpointIn}, out=${this.endpointOut})`);
                // Use endpoint packet size for transfer length (Android prefers max-packet)
                try {
                    const inEp = cand.alt.endpoints.find((ep)=>ep.type === 'bulk' && ep.direction === 'in');
                    if (inEp && inEp.packetSize) ;
                    else this._log(`[WebUSB] No packetSize found, keeping maxTransferSize=${this.maxTransferSize}`);
                } catch (e) {
                // Suppress packetSize check error - not critical
                }
                return config;
            } catch (claimErr) {
                lastErr = claimErr;
            // Suppress claim failed message - this is expected when trying multiple interfaces
            }
            throw lastErr || new Error('Unable to claim any USB interface');
        };
        let config;
        try {
            config = await attemptOpenAndClaim();
        } catch (err) {
            this._log('[WebUSB] open/claim failed, retrying after reset:', err.message);
            try {
                if (this.device.reset) await this.device.reset();
            } catch (e) {}
            try {
                await this.device.close();
            } catch (e) {}
            try {
                config = await attemptOpenAndClaim();
            } catch (err2) {
                throw new Error(`Unable to claim USB interface: ${err2.message}`);
            }
        }
        // Claim control interface if not already claimed
        if (this.controlInterface == null) {
            const controlIface = config.interfaces.find((i)=>i.alternates[0].interfaceClass === 0x02 && i.interfaceNumber !== this.interfaceNumber);
            if (controlIface) try {
                await this.device.claimInterface(controlIface.interfaceNumber);
                try {
                    await this.device.selectAlternateInterface(controlIface.interfaceNumber, 0);
                } catch (e) {}
                this.controlInterface = controlIface.interfaceNumber;
            } catch (e) {
                this.controlInterface = this.interfaceNumber;
            }
            else this.controlInterface = this.interfaceNumber;
        }
        // CP2102-specific initialization sequence (must be in this exact order!)
        if (this.device.vendorId === 0x10c4) try {
            // Step 1: Enable UART interface
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x00,
                value: 0x01,
                index: 0x00
            });
            // Step 2: Set line control (8N1: 8 data bits, no parity, 1 stop bit)
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x03,
                value: 0x0800,
                index: 0x00
            });
            // Step 3: Set DTR/RTS signals (vendor-specific for CP2102)
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x07,
                value: 771,
                index: 0x00
            });
            // Step 4: Set baudrate (vendor-specific for CP2102)
            // Use IFC_SET_BAUDRATE (0x1E) with direct 32-bit baudrate value
            const baudrateBuffer = new ArrayBuffer(4);
            const baudrateView = new DataView(baudrateBuffer);
            baudrateView.setUint32(0, baudRate, true); // little-endian
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'interface',
                request: 0x1E,
                value: 0,
                index: 0
            }, baudrateBuffer);
        } catch (e) {
            this._log('[WebUSB CP2102] Initialization error:', e.message);
        }
        else if (this.device.vendorId === 0x0403) try {
            // Step 1: Reset device
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x00,
                value: 0x00,
                index: 0x00
            });
            // Step 2: Set flow control to none
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x02,
                value: 0x00,
                index: 0x00
            });
            // Step 3: Set data characteristics (8N1)
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x04,
                value: 0x0008,
                index: 0x00
            });
            // Step 4: Set baudrate
            const baseClock = 3000000; // 48MHz / 16
            let divisor = baseClock / baudRate;
            const integerPart = Math.floor(divisor);
            const fractionalPart = divisor - integerPart;
            let subInteger;
            if (fractionalPart < 0.0625) subInteger = 0;
            else if (fractionalPart < 0.1875) subInteger = 1;
            else if (fractionalPart < 0.3125) subInteger = 2;
            else if (fractionalPart < 0.4375) subInteger = 3;
            else if (fractionalPart < 0.5625) subInteger = 4;
            else if (fractionalPart < 0.6875) subInteger = 5;
            else if (fractionalPart < 0.8125) subInteger = 6;
            else subInteger = 7;
            const value = integerPart & 0xFF | (subInteger & 0x07) << 14 | (integerPart >> 8 & 0x3F) << 8;
            const index = integerPart >> 14 & 0x03;
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x03,
                value: value,
                index: index
            });
            // Step 5: Set DTR/RTS (modem control)
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x01,
                value: 0x0303,
                index: 0x00
            });
        } catch (e) {
            this._log('[WebUSB FTDI] Initialization error:', e.message);
        }
        else if (this.device.vendorId === 0x1a86 && this.device.productId !== 0x55d3) try {
            // Step 1: Initialize CH340
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0xA1,
                value: 0x0000,
                index: 0x0000
            });
            // Step 2: Set baudrate
            const CH341_BAUDBASE_FACTOR = 1532620800;
            const CH341_BAUDBASE_DIVMAX = 3;
            let factor = Math.floor(CH341_BAUDBASE_FACTOR / baudRate);
            let divisor = CH341_BAUDBASE_DIVMAX;
            while(factor > 0xfff0 && divisor > 0){
                factor >>= 3;
                divisor--;
            }
            if (factor > 0xfff0) throw new Error(`Baudrate ${baudRate} not supported by CH340`);
            factor = 0x10000 - factor;
            const a = factor & 0xff00 | divisor;
            const b = factor & 0xff;
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x9A,
                value: 0x1312,
                index: a
            });
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x9A,
                value: 0x0f2c,
                index: b
            });
            // Step 3: Set handshake (DTR/RTS)
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0xA4,
                value: 65439,
                index: 0x0000
            });
        } catch (e) {
            this._log('[WebUSB CH340] Initialization error:', e.message);
        }
        else {
            // Standard CDC/ACM initialization for other chips
            try {
                const lineCoding = new Uint8Array([
                    baudRate & 0xFF,
                    baudRate >> 8 & 0xFF,
                    baudRate >> 16 & 0xFF,
                    baudRate >> 24 & 0xFF,
                    0x00,
                    0x00,
                    0x08 // 8 data bits
                ]);
                await this.device.controlTransferOut({
                    requestType: 'class',
                    recipient: 'interface',
                    request: 0x20,
                    value: 0,
                    index: this.controlInterface || 0
                }, lineCoding);
            } catch (e) {
                this._log('Could not set line coding:', e.message);
            }
            // Initialize DTR/RTS to idle state (both HIGH/asserted)
            try {
                await this.device.controlTransferOut({
                    requestType: 'class',
                    recipient: 'interface',
                    request: 0x22,
                    value: 0x03,
                    index: this.controlInterface || 0
                });
            } catch (e) {
                this._log('Could not set control lines:', e.message);
            }
        }
        // Create streams only if they don't exist yet
        if (!this.readableStream || !this.writableStream) this._createStreams();
        else // Streams exist, but make sure read loop is running
        if (!this._readLoopRunning) {
            this._readLoopRunning = true;
            // Note: ReadableStream can't be restarted, we need to recreate it
            this._createStreams();
        }
        // Setup disconnect handler only once
        if (!this._usbDisconnectHandler) {
            this._usbDisconnectHandler = (event)=>{
                if (event.device === this.device) {
                    this._fireEvent('disconnect');
                    this._cleanup();
                }
            };
            navigator.usb.addEventListener('disconnect', this._usbDisconnectHandler);
        }
    }
    /**
     * Close the device (mimics port.close())
     */ async close() {
        this._cleanup();
        if (this.device) try {
            if (this.interfaceNumber !== null) await this.device.releaseInterface(this.interfaceNumber);
            if (this.controlInterface !== null && this.controlInterface !== this.interfaceNumber) await this.device.releaseInterface(this.controlInterface);
            await this.device.close();
        } catch (e) {
            if (!e.message || !e.message.includes('disconnected')) this._log('Error closing device:', e.message || e);
        }
    }
    /**
     * Disconnect and clear device reference (for final cleanup)
     */ async disconnect() {
        await this.close();
        this.device = null;
    }
    /**
     * Get optimal block size for flash read operations
     * (maxTransferSize - 2) / 2
     * This accounts for SLIP overhead and escape sequences
     * @returns {number} Optimal block size in bytes
     */ getOptimalReadBlockSize() {
        // Formula for WebUSB:
        // blockSize = (maxTransferSize - 2) / 2
        // -2 for SLIP frame delimiters (0xC0 at start/end)
        // /2 because worst case every byte could be escaped (0xDB 0xDC or 0xDB 0xDD)
        return Math.floor((this.maxTransferSize - 2) / 2);
    }
    /**
     * Get device info (mimics port.getInfo())
     */ getInfo() {
        if (!this.device) return {};
        return {
            usbVendorId: this.device.vendorId,
            usbProductId: this.device.productId,
            productName: this.device.productName || ""
        };
    }
    /**
     * Set DTR/RTS signals (mimics port.setSignals())
     * CRITICAL: Commands are serialized via queue for CP2102 compatibility
     * Supports both CDC/ACM (CH343) and Vendor-Specific (CP2102, CH340)
     */ async setSignals(signals) {
        // Serialize all control transfers through a queue
        // This is CRITICAL for CP2102 - parallel commands cause hangs
        this._commandQueue = this._commandQueue.then(async ()=>{
            if (!this.device) throw new Error('Device not open');
            const vid = this.device.vendorId;
            const pid = this.device.productId;
            // Detect chip type and use appropriate control request
            // CP2102 (Silicon Labs VID: 0x10c4)
            if (vid === 0x10c4) return await this._setSignalsCP2102(signals);
            else if (vid === 0x1a86 && pid !== 0x55d3) return await this._setSignalsCH340(signals);
            else return await this._setSignalsCDC(signals);
        }).catch((err)=>{
            this._log('[WebUSB] setSignals error:', err);
            throw err;
        });
        return this._commandQueue;
    }
    /**
     * Set signals using CDC/ACM standard (for CH343, Native USB)
     */ async _setSignalsCDC(signals) {
        // Preserve current state for unspecified signals (Web Serial semantics)
        const dtr = signals.dataTerminalReady !== undefined ? signals.dataTerminalReady : this._currentDTR;
        const rts = signals.requestToSend !== undefined ? signals.requestToSend : this._currentRTS;
        // Update tracked state
        this._currentDTR = dtr;
        this._currentRTS = rts;
        let value = 0;
        value |= dtr ? 1 : 0;
        value |= rts ? 2 : 0;
        try {
            const result = await this.device.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: 0x22,
                value: value,
                index: this.controlInterface || 0
            });
            await new Promise((resolve)=>setTimeout(resolve, 50));
            return result;
        } catch (e) {
            this._log(`[WebUSB CDC] Failed to set signals: ${e.message}`);
            throw e;
        }
    }
    /**
     * Set signals for CP2102 (Silicon Labs vendor-specific)
     */ async _setSignalsCP2102(signals) {
        // CP2102 uses vendor-specific request 0x07 (SET_MHS)
        // Bit 0: DTR, Bit 1: RTS, Bit 8-9: DTR/RTS mask
        // Preserve current state for unspecified signals (Web Serial semantics)
        const dtr = signals.dataTerminalReady !== undefined ? signals.dataTerminalReady : this._currentDTR;
        const rts = signals.requestToSend !== undefined ? signals.requestToSend : this._currentRTS;
        // Update tracked state
        this._currentDTR = dtr;
        this._currentRTS = rts;
        // Build value with mask bits for both signals
        let value = 0;
        value |= (dtr ? 1 : 0) | 0x100; // DTR + mask
        value |= (rts ? 2 : 0) | 0x200; // RTS + mask
        try {
            const result = await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x07,
                value: value,
                index: 0x00 // CP2102 always uses index 0
            });
            await new Promise((resolve)=>setTimeout(resolve, 50));
            return result;
        } catch (e) {
            this._log(`[WebUSB CP2102] Failed to set signals: ${e.message}`);
            throw e;
        }
    }
    /**
     * Set signals for CH340 (WCH vendor-specific)
     */ async _setSignalsCH340(signals) {
        // Preserve current state for unspecified signals (Web Serial semantics)
        const dtr = signals.dataTerminalReady !== undefined ? signals.dataTerminalReady : this._currentDTR;
        const rts = signals.requestToSend !== undefined ? signals.requestToSend : this._currentRTS;
        // Update tracked state
        this._currentDTR = dtr;
        this._currentRTS = rts;
        // CH340 uses vendor-specific request 0xA4
        // Bit 5: DTR, Bit 6: RTS (inverted logic!)
        // Calculate value with bitwise NOT and mask to unsigned 16-bit
        const value = ~((dtr ? 32 : 0) | (rts ? 64 : 0)) & 0xffff;
        try {
            const result = await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0xA4,
                value: value,
                index: 0
            });
            await new Promise((resolve)=>setTimeout(resolve, 50));
            return result;
        } catch (e) {
            this._log(`[WebUSB CH340] Failed to set signals: ${e.message}`);
            throw e;
        }
    }
    /**
     * Change baudrate after port is already open
     * This is needed for ESP stub loader which changes baudrate after uploading stub
     * NOTE: Only needed for vendor-specific chips (CP2102, CH340, FTDI)
     * CDC devices (CH343, ESP32-S2/S3/C3 Native USB) handle baudrate automatically
     */ async setBaudRate(baudRate) {
        if (!this.device) throw new Error('Device not open');
        const vid = this.device.vendorId;
        const pid = this.device.productId;
        //        this._log(`[WebUSB] Changing baudrate to ${baudRate}...`);
        // FTDI (VID: 0x0403)
        if (vid === 0x0403) {
            // FTDI baudrate calculation
            // Modern FTDI chips (FT232R, FT2232, etc.): BaseClock = 48MHz
            // BaudDivisor = (48000000 / 16) / BaudRate = 3000000 / BaudRate
            // Divisor encoding: 16-bit value with sub-integer divisor support
            // Sub-integer divisor: 0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875
            const baseClock = 3000000; // 48MHz / 16
            let divisor = baseClock / baudRate;
            // Extract integer and fractional parts
            const integerPart = Math.floor(divisor);
            const fractionalPart = divisor - integerPart;
            // Encode sub-integer divisor (0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875)
            let subInteger;
            if (fractionalPart < 0.0625) subInteger = 0; // 0.0
            else if (fractionalPart < 0.1875) subInteger = 1; // 0.125
            else if (fractionalPart < 0.3125) subInteger = 2; // 0.25
            else if (fractionalPart < 0.4375) subInteger = 3; // 0.375
            else if (fractionalPart < 0.5625) subInteger = 4; // 0.5
            else if (fractionalPart < 0.6875) subInteger = 5; // 0.625
            else if (fractionalPart < 0.8125) subInteger = 6; // 0.75
            else subInteger = 7; // 0.875
            // Encode divisor value for FTDI
            // Low byte: integer part (bits 0-7)
            // High byte: (integer part >> 8) | (sub-integer << 6)
            const value = integerPart & 0xFF | (subInteger & 0x07) << 14 | (integerPart >> 8 & 0x3F) << 8;
            const index = integerPart >> 14 & 0x03; // Upper 2 bits of integer part
            //            this._log(`[WebUSB FTDI] Setting baudrate ${baudRate} (divisor=${divisor.toFixed(3)}, value=0x${value.toString(16)}, index=0x${index.toString(16)})...`);
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x03,
                value: value,
                index: index
            });
        //            this._log('[WebUSB FTDI] Baudrate changed successfully');
        } else if (vid === 0x10c4) {
            // CP210x baudrate encoding (from Silicon Labs AN571)
            // For CP2102/CP2103: Use direct 32-bit baudrate value
            // Request: IFC_SET_BAUDRATE (0x1E)
            // Encode baudrate as 32-bit little-endian value
            const baudrateBuffer = new ArrayBuffer(4);
            const baudrateView = new DataView(baudrateBuffer);
            baudrateView.setUint32(0, baudRate, true); // little-endian
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'interface',
                request: 0x1E,
                value: 0,
                index: 0
            }, baudrateBuffer);
        } else if (vid === 0x1a86 && pid !== 0x55d3) {
            // CH340 baudrate calculation (from Linux kernel driver)
            const CH341_BAUDBASE_FACTOR = 1532620800;
            const CH341_BAUDBASE_DIVMAX = 3;
            let factor = Math.floor(CH341_BAUDBASE_FACTOR / baudRate);
            let divisor = CH341_BAUDBASE_DIVMAX;
            // Reduce factor if too large
            while(factor > 0xfff0 && divisor > 0){
                factor >>= 3;
                divisor--;
            }
            if (factor > 0xfff0) throw new Error(`Baudrate ${baudRate} not supported by CH340`);
            factor = 0x10000 - factor;
            const a = factor & 0xff00 | divisor;
            const b = factor & 0xff;
            // CH340 uses request 0x9A to set baudrate
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x9A,
                value: 0x1312,
                index: a
            });
            // Second control transfer with b value
            await this.device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 0x9A,
                value: 0x0f2c,
                index: b
            });
        }
        // CDC devices (CH343, ESP32 Native USB) - no action needed in setBaudRate()
        // They are handled by close/reopen in esp_loader.ts
        // Wait for baudrate change to take effect
        await new Promise((resolve)=>setTimeout(resolve, 50));
    }
    get readable() {
        return this.readableStream;
    }
    get writable() {
        return this.writableStream;
    }
    _createStreams() {
        // ReadableStream for incoming data
        this.readableStream = new ReadableStream({
            start: async (controller)=>{
                this._readLoopRunning = true;
                let streamErrored = false;
                // Validate endpoints before starting read loop
                if (this.endpointIn == null) {
                    controller.error(new Error('Bulk IN endpoint not configured'));
                    return;
                }
                try {
                    while(this._readLoopRunning && this.device)try {
                        // CRITICAL: Check backpressure before reading more data
                        // If desiredSize is 0 or negative, the consumer can't keep up
                        // Wait for the consumer to drain the buffer before reading more
                        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                            // Consumer is backlogged - wait before reading more
                            await new Promise((r)=>setTimeout(r, 10));
                            continue;
                        }
                        const result = await this.device.transferIn(this.endpointIn, this.maxTransferSize);
                        if (result.status === 'ok') {
                            controller.enqueue(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength));
                            // Small delay to allow consumer to process data
                            // This prevents overwhelming the TextDecoderStream on Android
                            await new Promise((r)=>setTimeout(r, 1));
                            continue;
                        } else if (result.status === 'stall') {
                            await this.device.clearHalt('in', this.endpointIn);
                            await new Promise((r)=>setTimeout(r, 1));
                            continue;
                        }
                        // Only wait if no data was received
                        await new Promise((r)=>setTimeout(r, 1));
                    } catch (error) {
                        if (error.message && (error.message.includes('device unavailable') || error.message.includes('device has been lost') || error.message.includes('device was disconnected') || error.message.includes('No device selected'))) break;
                        if (error.message && (error.message.includes('transfer was cancelled') || error.message.includes('transfer error has occurred'))) continue;
                        this._log('USB read error:', error.message);
                        // Wait a bit after error before retrying
                        await new Promise((r)=>setTimeout(r, 10));
                    }
                } catch (error) {
                    streamErrored = true;
                    controller.error(error);
                } finally{
                    // Only close if stream didn't error
                    if (!streamErrored) controller.close();
                }
            },
            cancel: ()=>{
                this._readLoopRunning = false;
            }
        });
        // WritableStream for outgoing data
        this.writableStream = new WritableStream({
            write: async (chunk)=>{
                if (!this.device) throw new Error('Device not open');
                if (this.endpointOut == null) throw new Error('Bulk OUT endpoint not configured');
                await this.device.transferOut(this.endpointOut, chunk);
            }
        });
    }
    /**
     * Recreate streams without closing the port
     * Useful after hardware reset or when switching to console mode
     * This stops the current read loop and creates fresh streams
     */ recreateStreams() {
        // Stop the current read loop
        this._readLoopRunning = false;
        // Wait a bit for the read loop to finish
        // The ReadableStream will close itself when _readLoopRunning becomes false
        return new Promise((resolve)=>{
            setTimeout(()=>{
                // Create new streams
                this._createStreams();
                resolve();
            }, 100);
        });
    }
    _cleanup() {
        this._readLoopRunning = false;
        if (this._usbDisconnectHandler) {
            navigator.usb.removeEventListener('disconnect', this._usbDisconnectHandler);
            this._usbDisconnectHandler = null;
        }
    }
    _fireEvent(type) {
        const listeners = this._eventListeners[type] || [];
        listeners.forEach((listener)=>{
            try {
                listener();
            } catch (e) {
                this._log(`Error in ${type} event listener:`, e);
            }
        });
    }
    addEventListener(type, listener) {
        if (this._eventListeners[type]) this._eventListeners[type].push(listener);
    }
    removeEventListener(type, listener) {
        if (this._eventListeners[type]) {
            const index = this._eventListeners[type].indexOf(listener);
            if (index !== -1) this._eventListeners[type].splice(index, 1);
        }
    }
}
/**
 * Unified port request function that tries WebUSB first on Android, Web Serial on Desktop
 * This provides seamless support for both desktop (Web Serial) and Android (WebUSB)
 * @param {boolean} forceNew - If true, forces selection of a new device (ignores already paired devices)
 */ async function $d3c0f20c363d2d06$export$8c99db40de14d118(forceNew = false) {
    // Detect if we're on Android
    const isAndroid = /Android/i.test(navigator.userAgent);
    const hasSerial = 'serial' in navigator;
    const hasUSB = 'usb' in navigator;
    console.log(`[requestSerialPort] Platform: ${isAndroid ? 'Android' : 'Desktop'}, Web Serial: ${hasSerial}, WebUSB: ${hasUSB}`);
    // On Android, prefer WebUSB (Web Serial doesn't work properly)
    if (isAndroid && hasUSB) try {
        return await $d3c0f20c363d2d06$export$64a7c750323e1936.requestPort(null, forceNew);
    } catch (err) {
        console.log('WebUSB failed, trying Web Serial...', err.message);
    }
    // Try Web Serial API (preferred on desktop)
    if (hasSerial) try {
        // Web Serial API doesn't support device reuse in the same way
        // It always shows the picker, but the browser remembers permissions
        return await navigator.serial.requestPort();
    } catch (err) {
        console.log('Web Serial not available or cancelled, trying WebUSB...');
    }
    // Fall back to WebUSB
    if (hasUSB) try {
        return await $d3c0f20c363d2d06$export$64a7c750323e1936.requestPort(null, forceNew);
    } catch (err) {
        throw new Error('Neither Web Serial nor WebUSB available or user cancelled');
    }
    throw new Error('Neither Web Serial API nor WebUSB is supported in this browser');
}
// Also set on globalThis for non-module usage (e.g., dynamic script loading)
if (typeof globalThis !== 'undefined') {
    globalThis.WebUSBSerial = $d3c0f20c363d2d06$export$64a7c750323e1936;
    globalThis.requestSerialPort = $d3c0f20c363d2d06$export$8c99db40de14d118;
}
/**
 * XIAO nRF52840 Bootloader専用〠
 * PC / AndroidともWebUSBを使用してProduct Stringを取得する
 */ async function $d3c0f20c363d2d06$export$955e3ae996a6b124(forceNew = true) {
    if (!navigator.usb) throw new Error('WebUSB is not supported in this browser');
    return await $d3c0f20c363d2d06$export$64a7c750323e1936.requestPort(null, forceNew);
}


// adafruit-dfu.js
//
// Adafruit nRF52 legacy Serial DFU transport
// First test: HCI/SLIP packet -> ACK
const $524f1288a2f15fe5$var$SLIP_END = 0xC0;
const $524f1288a2f15fe5$var$SLIP_ESC = 0xDB;
const $524f1288a2f15fe5$var$SLIP_ESC_END = 0xDC;
const $524f1288a2f15fe5$var$SLIP_ESC_ESC = 0xDD;
const $524f1288a2f15fe5$var$DATA_INTEGRITY_CHECK_PRESENT = 1;
const $524f1288a2f15fe5$var$RELIABLE_PACKET = 1;
const $524f1288a2f15fe5$var$HCI_PACKET_TYPE = 14;
let $524f1288a2f15fe5$var$sequenceNumber = 0;
// ------------------------------------------------------------
// 32bit little-endian変換〠
// ------------------------------------------------------------
function $524f1288a2f15fe5$var$int32LE(value) {
    return [
        value & 0xFF,
        value >>> 8 & 0xFF,
        value >>> 16 & 0xFF,
        value >>> 24 & 0xFF
    ];
}
// ------------------------------------------------------------
// HCI header
// Equivalent to nrfutil slip_parts_to_four_bytes()
// ------------------------------------------------------------
function $524f1288a2f15fe5$var$makeHeader(seq, dip, rp, packetType, packetLength) {
    const h = new Uint8Array(4);
    h[0] = seq & 0x07 | (seq + 1) % 8 << 3 | (dip & 1) << 6 | (rp & 1) << 7;
    h[1] = packetType & 0x0F | (packetLength & 0x000F) << 4;
    h[2] = (packetLength & 0x0FF0) >> 4;
    h[3] = ~(h[0] + h[1] + h[2]) + 1 & 0xFF;
    return h;
}
// ------------------------------------------------------------
// CRC16 used by Nordic legacy DFU
// CRC-16/CCITT reflected
// poly = 0x8408
// initial = 0xffff
// ------------------------------------------------------------
function $524f1288a2f15fe5$var$crc16(data) {
    let crc = 0xFFFF;
    for (const byte of data){
        crc = (crc >> 8 | crc << 8) & 0xFFFF;
        crc ^= byte;
        crc ^= (crc & 0xFF) >> 4;
        crc ^= crc << 12 & 0xFFFF;
        crc ^= (crc & 0xFF) << 5 & 0xFFFF;
        crc &= 0xFFFF;
    }
    return crc;
}
// ------------------------------------------------------------
// SLIP escape
// ------------------------------------------------------------
function $524f1288a2f15fe5$var$slipEncode(data) {
    const out = [
        $524f1288a2f15fe5$var$SLIP_END
    ];
    for (const b of data){
        if (b === $524f1288a2f15fe5$var$SLIP_END) out.push($524f1288a2f15fe5$var$SLIP_ESC, $524f1288a2f15fe5$var$SLIP_ESC_END);
        else if (b === $524f1288a2f15fe5$var$SLIP_ESC) out.push($524f1288a2f15fe5$var$SLIP_ESC, $524f1288a2f15fe5$var$SLIP_ESC_ESC);
        else out.push(b);
    }
    out.push($524f1288a2f15fe5$var$SLIP_END);
    return new Uint8Array(out);
}
// ------------------------------------------------------------
// SLIP decode
// ------------------------------------------------------------
function $524f1288a2f15fe5$var$slipDecode(data) {
    const out = [];
    for(let i = 0; i < data.length; i++){
        const b = data[i];
        if (b === $524f1288a2f15fe5$var$SLIP_END) continue;
        if (b === $524f1288a2f15fe5$var$SLIP_ESC) {
            i++;
            if (i >= data.length) break;
            if (data[i] === $524f1288a2f15fe5$var$SLIP_ESC_END) out.push($524f1288a2f15fe5$var$SLIP_END);
            else if (data[i] === $524f1288a2f15fe5$var$SLIP_ESC_ESC) out.push($524f1288a2f15fe5$var$SLIP_ESC);
            else throw new Error("Invalid SLIP escape");
        } else out.push(b);
    }
    return new Uint8Array(out);
}
// ------------------------------------------------------------
// Build HCI packet
// ------------------------------------------------------------
function $524f1288a2f15fe5$var$buildHciPacket(payload) {
    $524f1288a2f15fe5$var$sequenceNumber = ($524f1288a2f15fe5$var$sequenceNumber + 1) % 8;
    const header = $524f1288a2f15fe5$var$makeHeader($524f1288a2f15fe5$var$sequenceNumber, $524f1288a2f15fe5$var$DATA_INTEGRITY_CHECK_PRESENT, $524f1288a2f15fe5$var$RELIABLE_PACKET, $524f1288a2f15fe5$var$HCI_PACKET_TYPE, payload.length);
    const raw = new Uint8Array(header.length + payload.length);
    raw.set(header, 0);
    raw.set(payload, 4);
    const crc = $524f1288a2f15fe5$var$crc16(raw);
    const withCRC = new Uint8Array(raw.length + 2);
    withCRC.set(raw, 0);
    // Nordic implementation sends CRC little endian
    withCRC[raw.length] = crc & 0xFF;
    withCRC[raw.length + 1] = crc >> 8 & 0xFF;
    return {
        sequence: $524f1288a2f15fe5$var$sequenceNumber,
        packet: $524f1288a2f15fe5$var$slipEncode(withCRC)
    };
}
class $524f1288a2f15fe5$export$6f8da3a76fb818d {
    constructor(port, logger = console.log){
        this.port = port;
        this.log = logger;
        this.reader = null;
        this.writer = null;
    }
    async start() {
        $524f1288a2f15fe5$var$sequenceNumber = 0;
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
        return Array.from(data).map((v)=>v.toString(16).padStart(2, "0")).join(" ");
    }
    async readAck(timeoutMs = 1500, verbose = true) {
        const received = [];
        const deadline = Date.now() + timeoutMs;
        while(Date.now() < deadline){
            const remaining = deadline - Date.now();
            let result;
            try {
                result = await Promise.race([
                    this.reader.read(),
                    new Promise((_, reject)=>setTimeout(()=>reject(new Error("ACK timeout")), remaining))
                ]);
            } catch (e) {
                throw new Error("ACK timeout");
            }
            if (result.done) throw new Error("Serial stream closed");
            for (const b of result.value){
                received.push(b);
                // nrfutil waits until two C0 delimiters exist
                const endCount = received.filter((v)=>v === $524f1288a2f15fe5$var$SLIP_END).length;
                if (endCount >= 2) {
                    const frame = new Uint8Array(received);
                    if (verbose) this.log("[DFU RX RAW] " + this.hex(frame));
                    const decoded = $524f1288a2f15fe5$var$slipDecode(frame);
                    if (verbose) this.log("[DFU RX] " + this.hex(decoded));
                    if (decoded.length < 1) throw new Error("Invalid ACK packet");
                    const ack = decoded[0] >> 3 & 0x07;
                    if (verbose) this.log("[DFU] ACK sequence = " + ack);
                    return ack;
                }
            }
        }
        throw new Error("ACK timeout");
    }
    // --------------------------------------------------------
    // Transport-only test
    //
    // Sends an empty reliable HCI packet.
    // We are testing HCI ACK only.
    // --------------------------------------------------------
    async testAck() {
        const payload = new Uint8Array(0);
        const built = $524f1288a2f15fe5$var$buildHciPacket(payload);
        this.log("[DFU] TX sequence = " + built.sequence);
        this.log("[DFU TX RAW] " + this.hex(built.packet));
        await this.writer.write(built.packet);
        const ack = await this.readAck();
        const expectedAck = (built.sequence + 1) % 8;
        if (ack !== expectedAck) throw new Error(`ACK mismatch: TX=${built.sequence}, ` + `expected=${expectedAck}, RX=${ack}`);
        this.log(`[DFU] HCI ACK OK (TX=${built.sequence}, next=${ack})`);
        return true;
    }
    async sendStartDfu(mode, softdeviceSize, bootloaderSize, applicationSize) {
        const payload = new Uint8Array([
            ...$524f1288a2f15fe5$var$int32LE(3),
            ...$524f1288a2f15fe5$var$int32LE(mode),
            ...$524f1288a2f15fe5$var$int32LE(softdeviceSize),
            ...$524f1288a2f15fe5$var$int32LE(bootloaderSize),
            ...$524f1288a2f15fe5$var$int32LE(applicationSize)
        ]);
        this.log("[DFU] START payload: " + this.hex(payload));
        const built = $524f1288a2f15fe5$var$buildHciPacket(payload);
        this.log("[DFU] START TX sequence = " + built.sequence);
        this.log("[DFU START TX RAW] " + this.hex(built.packet));
        await this.writer.write(built.packet);
        const ack = await this.readAck(3000);
        const expectedAck = (built.sequence + 1) % 8;
        if (ack !== expectedAck) throw new Error(`START ACK mismatch: TX=${built.sequence}, ` + `expected=${expectedAck}, RX=${ack}`);
        this.log(`[DFU] START ACK OK (TX=${built.sequence}, next=${ack})`);
        return true;
    }
    async sendInitPacket(initPacket) {
        const payload = new Uint8Array(4 + initPacket.length + 2);
        // DFU_INIT_PACKET = 1
        payload.set($524f1288a2f15fe5$var$int32LE(1), 0);
        // Signed .dat
        payload.set(initPacket, 4);
        // Required padding
        payload[payload.length - 2] = 0x00;
        payload[payload.length - 1] = 0x00;
        this.log("[DFU] INIT size = " + initPacket.length);
        this.log("[DFU] INIT payload size = " + payload.length);
        this.log("[DFU] INIT payload: " + this.hex(payload));
        const built = $524f1288a2f15fe5$var$buildHciPacket(payload);
        this.log("[DFU] INIT TX sequence = " + built.sequence);
        this.log("[DFU INIT TX RAW] " + this.hex(built.packet));
        await this.writer.write(built.packet);
        const ack = await this.readAck(3000);
        const expectedAck = (built.sequence + 1) % 8;
        if (ack !== expectedAck) throw new Error(`INIT ACK mismatch: TX=${built.sequence}, ` + `expected=${expectedAck}, RX=${ack}`);
        this.log(`[DFU] INIT ACK OK (TX=${built.sequence}, next=${ack})`);
        return true;
    }
    async sendDataPacket(data) {
        if (data.length > 512) throw new Error("DFU DATA chunk too large: " + data.length);
        const payload = new Uint8Array(4 + data.length);
        // DFU_DATA_PACKET = 4
        payload.set($524f1288a2f15fe5$var$int32LE(4), 0);
        // Firmware data
        payload.set(data, 4);
        const built = $524f1288a2f15fe5$var$buildHciPacket(payload);
        try {
            await this.writer.write(built.packet);
        } catch (e) {
            this.log(`[DFU] DATA USB WRITE ERROR: ${e?.name || "Error"}: ${e?.message || e}`);
            throw e;
        }
        const ack = await this.readAck(3000, false);
        const expectedAck = (built.sequence + 1) % 8;
        if (ack !== expectedAck) throw new Error(`DATA ACK mismatch: TX=${built.sequence}, ` + `expected=${expectedAck}, RX=${ack}`);
        return true;
    }
    async sendFirmware(firmware, progressCallback = null) {
        const CHUNK_SIZE = 512;
        const PAGE_PACKET_COUNT = 8;
        const PAGE_WRITE_WAIT_MS = 103;
        const totalPackets = Math.ceil(firmware.length / CHUNK_SIZE);
        this.log(`[DFU] Firmware size = ${firmware.length} bytes`);
        this.log(`[DFU] Total DATA packets = ${totalPackets}`);
        let packetCount = 0;
        for(let offset = 0; offset < firmware.length; offset += CHUNK_SIZE){
            const end = Math.min(offset + CHUNK_SIZE, firmware.length);
            const chunk = firmware.slice(offset, end);
            // this.log(
            //      `[DFU] DATA packet ${packetCount + 1}/${totalPackets}, ` +
            //      `offset=${offset}, size=${chunk.length}`
            //  );
            await this.sendDataPacket(chunk);
            packetCount++;
            if (progressCallback) progressCallback(end, firmware.length);
            // Same pacing as nrfutil:
            // wait after every 8 DATA packets
            if (packetCount % PAGE_PACKET_COUNT === 0) await new Promise((resolve)=>setTimeout(resolve, PAGE_WRITE_WAIT_MS));
        }
        // Final flash write wait
        await new Promise((resolve)=>setTimeout(resolve, PAGE_WRITE_WAIT_MS));
        this.log(`[DFU] Firmware DATA complete: ` + `${packetCount} packets`);
        return true;
    }
    async sendStopDataPacket() {
        // DFU_STOP_DATA_PACKET = 5
        const payload = new Uint8Array($524f1288a2f15fe5$var$int32LE(5));
        this.log("[DFU] Sending STOP DATA packet");
        const built = $524f1288a2f15fe5$var$buildHciPacket(payload);
        this.log("[DFU] STOP TX sequence = " + built.sequence);
        this.log("[DFU STOP TX RAW] " + this.hex(built.packet));
        await this.writer.write(built.packet);
        const ack = await this.readAck(5000);
        const expectedAck = (built.sequence + 1) % 8;
        if (ack !== expectedAck) throw new Error(`STOP ACK mismatch: TX=${built.sequence}, ` + `expected=${expectedAck}, RX=${ack}`);
        this.log(`[DFU] STOP ACK OK ` + `(TX=${built.sequence}, next=${ack})`);
        return true;
    }
}


const $382e02c9bbd5d50b$var$programButton = document.getElementById("programButton");
const $382e02c9bbd5d50b$var$terminal = document.getElementById("terminal");
const $382e02c9bbd5d50b$var$table = document.getElementById("fileTable");
const $382e02c9bbd5d50b$var$alertDiv = document.getElementById("alertDiv");
// 縦幅を15行に固定し、自動改行お任せモードをONにしたターミナル初期化
const $382e02c9bbd5d50b$var$term = new Terminal({
    cols: 100,
    rows: 15,
    convertEol: true
});
$382e02c9bbd5d50b$var$term.open($382e02c9bbd5d50b$var$terminal);
let $382e02c9bbd5d50b$var$device = null;
let $382e02c9bbd5d50b$var$deviceInfo = null;
// ----------------------------------------------------
// 2. 共通プログラム検証
// ----------------------------------------------------
$382e02c9bbd5d50b$var$programButton.onclick = async ()=>{
    // Bootloader updaterは1回だけ実行
    $382e02c9bbd5d50b$var$programButton.disabled = true;
    $382e02c9bbd5d50b$var$programButton.style.display = "none";
    let progressBar = null;
    let progressRow = null;
    let writeCompleted = false;
    try {
        $382e02c9bbd5d50b$var$alertDiv.style.display = "none";
        // ----------------------------------------------------
        // USB選択 → XIAO Bootloader接続を自動実行
        // ----------------------------------------------------
        $382e02c9bbd5d50b$var$term.reset();
        $382e02c9bbd5d50b$var$term.writeln("==============================");
        $382e02c9bbd5d50b$var$term.writeln("XIAO nRF52840 Bootloader Update 0.21");
        $382e02c9bbd5d50b$var$term.writeln("==============================");
        $382e02c9bbd5d50b$var$term.writeln("Select XIAO nRF52840 Bootloader USB device.");
        $382e02c9bbd5d50b$var$device = await (0, $d3c0f20c363d2d06$export$8c99db40de14d118)(true);
        $382e02c9bbd5d50b$var$deviceInfo = $382e02c9bbd5d50b$var$device.getInfo();
        const vid = $382e02c9bbd5d50b$var$deviceInfo.usbVendorId;
        const pid = $382e02c9bbd5d50b$var$deviceInfo.usbProductId;
        $382e02c9bbd5d50b$var$term.writeln(`USB device: VID=0x${vid.toString(16).padStart(4, "0")} ` + `PID=0x${pid.toString(16).padStart(4, "0")}`);
        if (vid !== 0x2886 || pid !== 0x0045) throw new Error("XIAO nRF52840 Bootloader\u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002RESET\u3092\u7D20\u65E9\u304F2\u56DE\u62BC\u3057\u3066Bootloader\u30E2\u30FC\u30C9\u306B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
        $382e02c9bbd5d50b$var$term.writeln("XIAO nRF52840 Bootloader detected");
        $382e02c9bbd5d50b$var$term.writeln("Opening serial port...");
        await $382e02c9bbd5d50b$var$device.open({
            baudRate: 115200
        });
        $382e02c9bbd5d50b$var$term.writeln("Serial port opened successfully");
        $382e02c9bbd5d50b$var$term.writeln("Toggling DTR...");
        await $382e02c9bbd5d50b$var$device.setSignals({
            dataTerminalReady: false,
            requestToSend: false
        });
        await new Promise((resolve)=>setTimeout(resolve, 50));
        await $382e02c9bbd5d50b$var$device.setSignals({
            dataTerminalReady: true,
            requestToSend: false
        });
        await new Promise((resolve)=>setTimeout(resolve, 100));
        $382e02c9bbd5d50b$var$term.writeln("==============================");
        $382e02c9bbd5d50b$var$term.writeln("XIAO nRF52840 CONNECTED");
        $382e02c9bbd5d50b$var$term.writeln("Starting Bootloader update automatically.");
        $382e02c9bbd5d50b$var$term.writeln("==============================");
        // ----------------------------------------------------
        // Bootloader Update ZIPをサーバーから取得
        // ----------------------------------------------------
        const bootloaderZipUrl = "./firmware/xiao_nrf52840_ble_bootloader-0.11.0-dirty_s140_7.3.0.zip";
        $382e02c9bbd5d50b$var$term.writeln("==============================");
        $382e02c9bbd5d50b$var$term.writeln("BOOTLOADER UPDATE FILE");
        $382e02c9bbd5d50b$var$term.writeln("==============================");
        $382e02c9bbd5d50b$var$term.writeln("Downloading Bootloader Update ZIP...");
        const response = await fetch(bootloaderZipUrl, {
            cache: "no-store"
        });
        if (!response.ok) throw new Error(`Bootloader ZIP download failed: HTTP ${response.status}`);
        const zipData = await response.arrayBuffer();
        if (zipData.byteLength === 0) throw new Error("Bootloader ZIP is empty.");
        $382e02c9bbd5d50b$var$term.writeln("ZIP downloaded: " + zipData.byteLength + " bytes");
        const zip = await JSZip.loadAsync(zipData);
        $382e02c9bbd5d50b$var$term.writeln("Bootloader ZIP loaded.");
        // ----------------------------------------------------
        // manifest.json
        // ----------------------------------------------------
        const manifestEntry = zip.file("manifest.json");
        if (!manifestEntry) throw new Error("manifest.json not found.");
        const manifestText = await manifestEntry.async("text");
        const manifest = JSON.parse(manifestText);
        const sdBootloader = manifest?.manifest?.softdevice_bootloader;
        if (!sdBootloader) throw new Error("softdevice_bootloader entry not found in manifest.json");
        const binFileName = sdBootloader.bin_file;
        const datFileName = sdBootloader.dat_file;
        if (!binFileName || !datFileName) throw new Error("bin_file/dat_file not found in manifest.json");
        const softdeviceSize = Number(sdBootloader.sd_size);
        const bootloaderSize = Number(sdBootloader.bl_size);
        if (!Number.isInteger(softdeviceSize) || softdeviceSize <= 0) throw new Error("Invalid sd_size in manifest.json");
        if (!Number.isInteger(bootloaderSize) || bootloaderSize <= 0) throw new Error("Invalid bl_size in manifest.json");
        $382e02c9bbd5d50b$var$term.writeln("BIN from manifest: " + binFileName);
        $382e02c9bbd5d50b$var$term.writeln("DAT from manifest: " + datFileName);
        $382e02c9bbd5d50b$var$term.writeln("SoftDevice size: " + softdeviceSize + " bytes");
        $382e02c9bbd5d50b$var$term.writeln("Bootloader size: " + bootloaderSize + " bytes");
        // ----------------------------------------------------
        // BIN / DAT取得
        // ----------------------------------------------------
        const binEntry = zip.file(binFileName);
        if (!binEntry) throw new Error("BIN file not found: " + binFileName);
        const datEntry = zip.file(datFileName);
        if (!datEntry) throw new Error("DAT file not found: " + datFileName);
        const firmware = await binEntry.async("uint8array");
        const initPacket = await datEntry.async("uint8array");
        $382e02c9bbd5d50b$var$term.writeln("BIN size: " + firmware.length + " bytes");
        $382e02c9bbd5d50b$var$term.writeln("DAT size: " + initPacket.length + " bytes");
        // SD + BL のサイズをmanifestとBIN実サイズで照合
        const expectedFirmwareSize = softdeviceSize + bootloaderSize;
        if (firmware.length !== expectedFirmwareSize) throw new Error(`SD+BL size mismatch: BIN=${firmware.length}, ` + `manifest=${expectedFirmwareSize}`);
        $382e02c9bbd5d50b$var$term.writeln("==============================");
        $382e02c9bbd5d50b$var$term.writeln("Bootloader update file verified.");
        $382e02c9bbd5d50b$var$term.writeln("==============================");
        // ----------------------------------------------------
        // プログレスバー
        // ----------------------------------------------------
        progressRow = $382e02c9bbd5d50b$var$table.rows[0];
        progressBar = progressRow.cells[1].querySelector("progress");
        if (!progressBar) throw new Error("Progress bar not found.");
        progressRow.cells[1].style.display = "initial";
        progressBar.value = 0;
        $382e02c9bbd5d50b$var$term.writeln("");
        $382e02c9bbd5d50b$var$term.writeln("==============================");
        $382e02c9bbd5d50b$var$term.writeln("Bootloader 0.11.0\u3078\u306E\u66F4\u65B0\u3092\u958B\u59CB\u3057\u307E\u3059\u3002");
        $382e02c9bbd5d50b$var$term.writeln("\u66F4\u65B0\u304C\u5B8C\u4E86\u3059\u308B\u307E\u3067USB\u30B1\u30FC\u30D6\u30EB\u3092\u629C\u304B\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002");
        $382e02c9bbd5d50b$var$term.writeln("==============================");
        const dfu = new (0, $524f1288a2f15fe5$export$6f8da3a76fb818d)($382e02c9bbd5d50b$var$device, (msg)=>$382e02c9bbd5d50b$var$term.writeln(msg));
        try {
            await dfu.start();
            // ------------------------------------------------
            // START: SoftDevice + Bootloader
            // ------------------------------------------------
            $382e02c9bbd5d50b$var$term.writeln("Sending DFU START...");
            await dfu.sendStartDfu(3, softdeviceSize, bootloaderSize, 0);
            $382e02c9bbd5d50b$var$term.writeln("DFU START OK");
            // ------------------------------------------------
            // Flash erase wait
            // ------------------------------------------------
            const eraseWaitMs = Math.max(500, (Math.floor(firmware.length / 4096) + 1) * 89.7);
            $382e02c9bbd5d50b$var$term.writeln("Waiting for flash erase: " + Math.ceil(eraseWaitMs) + " ms");
            await new Promise((resolve)=>setTimeout(resolve, eraseWaitMs));
            // ------------------------------------------------
            // INIT
            // ------------------------------------------------
            $382e02c9bbd5d50b$var$term.writeln("Sending INIT packet...");
            await dfu.sendInitPacket(initPacket);
            $382e02c9bbd5d50b$var$term.writeln("INIT OK");
            // ------------------------------------------------
            // Firmware DATA
            // ------------------------------------------------
            $382e02c9bbd5d50b$var$term.writeln("Sending SoftDevice + Bootloader DATA...");
            let lastPercent = -1;
            await dfu.sendFirmware(firmware, (written, total)=>{
                const percent = Math.floor(written / total * 100);
                progressBar.value = percent;
                if (percent >= lastPercent + 10 || percent === 100) {
                    lastPercent = percent;
                    $382e02c9bbd5d50b$var$term.writeln(`DFU DATA: ${written}/${total} ` + `bytes (${percent}%)`);
                }
            });
            $382e02c9bbd5d50b$var$term.writeln("FIRMWARE DATA OK");
            // ------------------------------------------------
            // STOP
            // ------------------------------------------------
            $382e02c9bbd5d50b$var$term.writeln("Sending DFU STOP...");
            await dfu.sendStopDataPacket();
            $382e02c9bbd5d50b$var$term.writeln("DFU STOP OK");
            $382e02c9bbd5d50b$var$term.writeln("");
            $382e02c9bbd5d50b$var$term.writeln("==============================");
            $382e02c9bbd5d50b$var$term.writeln("Bootloader 0.11.0\u3078\u306E\u66F4\u65B0\u304C\u5B8C\u4E86\u3057\u307E\u3057\u305F\u3002");
            $382e02c9bbd5d50b$var$term.writeln("USB\u30B1\u30FC\u30D6\u30EB\u3092\u53D6\u308A\u5916\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
            $382e02c9bbd5d50b$var$term.writeln("==============================");
            writeCompleted = true;
            progressBar.value = 100;
            await new Promise((resolve)=>setTimeout(resolve, 500));
            progressRow.cells[1].style.display = "none";
        } finally{
            await dfu.stop();
        }
    } catch (e) {
        console.error(e);
        $382e02c9bbd5d50b$var$term.writeln(`ERROR: ${e.message}`);
    } finally{
        if (!writeCompleted) {
            // 更新失敗時は再試行できるようにする
            $382e02c9bbd5d50b$var$programButton.disabled = false;
            $382e02c9bbd5d50b$var$programButton.style.display = "initial";
            if (progressRow) progressRow.cells[1].style.display = "none";
        }
    }
};
function $382e02c9bbd5d50b$var$createBootloaderProgressRow() {
    const row = $382e02c9bbd5d50b$var$table.insertRow($382e02c9bbd5d50b$var$table.rows.length);
    const cell1 = row.insertCell(0);
    cell1.textContent = "Bootloader 0.11.0 \u66F4\u65B0\u30D5\u30A1\u30A4\u30EB\u306F\u81EA\u52D5\u7684\u306B\u8AAD\u307F\u8FBC\u307E\u308C\u307E\u3059\u3002";
    const cell2 = row.insertCell(1);
    cell2.classList.add("progress-cell");
    cell2.style.display = "none";
    cell2.innerHTML = `<progress value="0" max="100"></progress>`;
}
$382e02c9bbd5d50b$var$createBootloaderProgressRow();


//# sourceMappingURL=typescript.101b15c3.js.map
