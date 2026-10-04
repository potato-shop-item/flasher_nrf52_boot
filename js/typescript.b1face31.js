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
            usbProductId: this.device.productId
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
                    const decoded = $524f1288a2f15fe5$var$slipDecode(frame);
                    if (decoded.length < 1) throw new Error("Invalid ACK packet");
                    const ack = decoded[0] >> 3 & 0x07;
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
        const built = $524f1288a2f15fe5$var$buildHciPacket(payload);
        await this.writer.write(built.packet);
        const ack = await this.readAck(3000);
        const expectedAck = (built.sequence + 1) % 8;
        if (ack !== expectedAck) throw new Error(`START ACK mismatch: TX=${built.sequence}, ` + `expected=${expectedAck}, RX=${ack}`);
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
        const built = $524f1288a2f15fe5$var$buildHciPacket(payload);
        await this.writer.write(built.packet);
        const ack = await this.readAck(3000);
        const expectedAck = (built.sequence + 1) % 8;
        if (ack !== expectedAck) throw new Error(`INIT ACK mismatch: TX=${built.sequence}, ` + `expected=${expectedAck}, RX=${ack}`);
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
        await this.writer.write(built.packet);
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


/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in
 * compliance with the License. You may obtain a copy of
 * the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in
 * writing, software distributed under the License is
 * distributed on an "AS IS" BASIS, WITHOUT WARRANTIES
 * OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing
 * permissions and limitations under the License.
 */ 'use strict';
var $d2bbb828b377f05f$export$24d5ae9391ffe6e0;
(function(SerialPolyfillProtocol) {
    SerialPolyfillProtocol[SerialPolyfillProtocol["UsbCdcAcm"] = 0] = "UsbCdcAcm";
})($d2bbb828b377f05f$export$24d5ae9391ffe6e0 || ($d2bbb828b377f05f$export$24d5ae9391ffe6e0 = {}));
const $d2bbb828b377f05f$var$kSetLineCoding = 0x20;
const $d2bbb828b377f05f$var$kSetControlLineState = 0x22;
const $d2bbb828b377f05f$var$kSendBreak = 0x23;
const $d2bbb828b377f05f$var$kDefaultBufferSize = 255;
const $d2bbb828b377f05f$var$kDefaultDataBits = 8;
const $d2bbb828b377f05f$var$kDefaultParity = 'none';
const $d2bbb828b377f05f$var$kDefaultStopBits = 1;
const $d2bbb828b377f05f$var$kAcceptableDataBits = [
    16,
    8,
    7,
    6,
    5
];
const $d2bbb828b377f05f$var$kAcceptableStopBits = [
    1,
    2
];
const $d2bbb828b377f05f$var$kAcceptableParity = [
    'none',
    'even',
    'odd'
];
const $d2bbb828b377f05f$var$kParityIndexMapping = [
    'none',
    'odd',
    'even'
];
const $d2bbb828b377f05f$var$kStopBitsIndexMapping = [
    1,
    1.5,
    2
];
const $d2bbb828b377f05f$var$kDefaultPolyfillOptions = {
    protocol: $d2bbb828b377f05f$export$24d5ae9391ffe6e0.UsbCdcAcm,
    usbControlInterfaceClass: 2,
    usbTransferInterfaceClass: 10
};
/**
 * Utility function to get the interface implementing a desired class.
 * @param {USBDevice} device The USB device.
 * @param {number} classCode The desired interface class.
 * @return {USBInterface} The first interface found that implements the desired
 * class.
 * @throws TypeError if no interface is found.
 */ function $d2bbb828b377f05f$var$findInterface(device, classCode) {
    const configuration = device.configurations[0];
    for (const iface of configuration.interfaces){
        const alternate = iface.alternates[0];
        if (alternate.interfaceClass === classCode) return iface;
    }
    throw new TypeError(`Unable to find interface with class ${classCode}.`);
}
/**
 * Utility function to get an endpoint with a particular direction.
 * @param {USBInterface} iface The interface to search.
 * @param {USBDirection} direction The desired transfer direction.
 * @return {USBEndpoint} The first endpoint with the desired transfer direction.
 * @throws TypeError if no endpoint is found.
 */ function $d2bbb828b377f05f$var$findEndpoint(iface, direction) {
    const alternate = iface.alternates[0];
    for (const endpoint of alternate.endpoints){
        if (endpoint.direction == direction) return endpoint;
    }
    throw new TypeError(`Interface ${iface.interfaceNumber} does not have an ` + `${direction} endpoint.`);
}
/**
 * Implementation of the underlying source API[1] which reads data from a USB
 * endpoint. This can be used to construct a ReadableStream.
 *
 * [1]: https://streams.spec.whatwg.org/#underlying-source-api
 */ class $d2bbb828b377f05f$var$UsbEndpointUnderlyingSource {
    /**
     * Constructs a new UnderlyingSource that will pull data from the specified
     * endpoint on the given USB device.
     *
     * @param {USBDevice} device
     * @param {USBEndpoint} endpoint
     * @param {function} onError function to be called on error
     */ constructor(device, endpoint, onError){
        this.type = 'bytes';
        this.device_ = device;
        this.endpoint_ = endpoint;
        this.onError_ = onError;
    }
    /**
     * Reads a chunk of data from the device.
     *
     * @param {ReadableByteStreamController} controller
     */ pull(controller) {
        (async ()=>{
            var _a;
            let chunkSize;
            if (controller.desiredSize) {
                const d = controller.desiredSize / this.endpoint_.packetSize;
                chunkSize = Math.ceil(d) * this.endpoint_.packetSize;
            } else chunkSize = this.endpoint_.packetSize;
            try {
                const result = await this.device_.transferIn(this.endpoint_.endpointNumber, chunkSize);
                if (result.status != 'ok') {
                    controller.error(`USB error: ${result.status}`);
                    this.onError_();
                }
                if ((_a = result.data) === null || _a === void 0 ? void 0 : _a.buffer) {
                    const chunk = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
                    controller.enqueue(chunk);
                }
            } catch (error) {
                controller.error(error.toString());
                this.onError_();
            }
        })();
    }
}
/**
 * Implementation of the underlying sink API[2] which writes data to a USB
 * endpoint. This can be used to construct a WritableStream.
 *
 * [2]: https://streams.spec.whatwg.org/#underlying-sink-api
 */ class $d2bbb828b377f05f$var$UsbEndpointUnderlyingSink {
    /**
     * Constructs a new UnderlyingSink that will write data to the specified
     * endpoint on the given USB device.
     *
     * @param {USBDevice} device
     * @param {USBEndpoint} endpoint
     * @param {function} onError function to be called on error
     */ constructor(device, endpoint, onError){
        this.device_ = device;
        this.endpoint_ = endpoint;
        this.onError_ = onError;
    }
    /**
     * Writes a chunk to the device.
     *
     * @param {Uint8Array} chunk
     * @param {WritableStreamDefaultController} controller
     */ async write(chunk, controller) {
        try {
            const result = await this.device_.transferOut(this.endpoint_.endpointNumber, chunk);
            if (result.status != 'ok') {
                controller.error(result.status);
                this.onError_();
            }
        } catch (error) {
            controller.error(error.toString());
            this.onError_();
        }
    }
}
class $d2bbb828b377f05f$export$237d90817cb05a2f {
    /**
     * constructor taking a WebUSB device that creates a SerialPort instance.
     * @param {USBDevice} device A device acquired from the WebUSB API
     * @param {SerialPolyfillOptions} polyfillOptions Optional options to
     * configure the polyfill.
     */ constructor(device, polyfillOptions){
        this.polyfillOptions_ = Object.assign(Object.assign({}, $d2bbb828b377f05f$var$kDefaultPolyfillOptions), polyfillOptions);
        this.outputSignals_ = {
            dataTerminalReady: false,
            requestToSend: false,
            break: false
        };
        this.device_ = device;
        this.controlInterface_ = $d2bbb828b377f05f$var$findInterface(this.device_, this.polyfillOptions_.usbControlInterfaceClass);
        this.transferInterface_ = $d2bbb828b377f05f$var$findInterface(this.device_, this.polyfillOptions_.usbTransferInterfaceClass);
        this.inEndpoint_ = $d2bbb828b377f05f$var$findEndpoint(this.transferInterface_, 'in');
        this.outEndpoint_ = $d2bbb828b377f05f$var$findEndpoint(this.transferInterface_, 'out');
    }
    /**
     * Getter for the readable attribute. Constructs a new ReadableStream as
     * necessary.
     * @return {ReadableStream} the current readable stream
     */ get readable() {
        var _a;
        if (!this.readable_ && this.device_.opened) this.readable_ = new ReadableStream(new $d2bbb828b377f05f$var$UsbEndpointUnderlyingSource(this.device_, this.inEndpoint_, ()=>{
            this.readable_ = null;
        }), {
            highWaterMark: (_a = this.serialOptions_.bufferSize) !== null && _a !== void 0 ? _a : $d2bbb828b377f05f$var$kDefaultBufferSize
        });
        return this.readable_;
    }
    /**
     * Getter for the writable attribute. Constructs a new WritableStream as
     * necessary.
     * @return {WritableStream} the current writable stream
     */ get writable() {
        var _a;
        if (!this.writable_ && this.device_.opened) this.writable_ = new WritableStream(new $d2bbb828b377f05f$var$UsbEndpointUnderlyingSink(this.device_, this.outEndpoint_, ()=>{
            this.writable_ = null;
        }), new ByteLengthQueuingStrategy({
            highWaterMark: (_a = this.serialOptions_.bufferSize) !== null && _a !== void 0 ? _a : $d2bbb828b377f05f$var$kDefaultBufferSize
        }));
        return this.writable_;
    }
    /**
     * a function that opens the device and claims all interfaces needed to
     * control and communicate to and from the serial device
     * @param {SerialOptions} options Object containing serial options
     * @return {Promise<void>} A promise that will resolve when device is ready
     * for communication
     */ async open(options) {
        this.serialOptions_ = options;
        this.validateOptions();
        try {
            await this.device_.open();
            if (this.device_.configuration === null) await this.device_.selectConfiguration(1);
            await this.device_.claimInterface(this.controlInterface_.interfaceNumber);
            if (this.controlInterface_ !== this.transferInterface_) await this.device_.claimInterface(this.transferInterface_.interfaceNumber);
            await this.setLineCoding();
            await this.setSignals({
                dataTerminalReady: true
            });
        } catch (error) {
            if (this.device_.opened) await this.device_.close();
            throw new Error('Error setting up device: ' + error.toString());
        }
    }
    /**
     * Closes the port.
     *
     * @return {Promise<void>} A promise that will resolve when the port is
     * closed.
     */ async close() {
        const promises = [];
        if (this.readable_) promises.push(this.readable_.cancel());
        if (this.writable_) promises.push(this.writable_.abort());
        await Promise.all(promises);
        this.readable_ = null;
        this.writable_ = null;
        if (this.device_.opened) {
            await this.setSignals({
                dataTerminalReady: false,
                requestToSend: false
            });
            await this.device_.close();
        }
    }
    /**
     * Forgets the port.
     *
     * @return {Promise<void>} A promise that will resolve when the port is
     * forgotten.
     */ async forget() {
        return this.device_.forget();
    }
    /**
     * A function that returns properties of the device.
     * @return {SerialPortInfo} Device properties.
     */ getInfo() {
        return {
            usbVendorId: this.device_.vendorId,
            usbProductId: this.device_.productId
        };
    }
    /**
     * A function used to change the serial settings of the device
     * @param {object} options the object which carries serial settings data
     * @return {Promise<void>} A promise that will resolve when the options are
     * set
     */ reconfigure(options) {
        this.serialOptions_ = Object.assign(Object.assign({}, this.serialOptions_), options);
        this.validateOptions();
        return this.setLineCoding();
    }
    /**
     * Sets control signal state for the port.
     * @param {SerialOutputSignals} signals The signals to enable or disable.
     * @return {Promise<void>} a promise that is resolved when the signal state
     * has been changed.
     */ async setSignals(signals) {
        this.outputSignals_ = Object.assign(Object.assign({}, this.outputSignals_), signals);
        if (signals.dataTerminalReady !== undefined || signals.requestToSend !== undefined) {
            // The Set_Control_Line_State command expects a bitmap containing the
            // values of all output signals that should be enabled or disabled.
            //
            // Ref: USB CDC specification version 1.1 §6.2.14.
            const value = (this.outputSignals_.dataTerminalReady ? 1 : 0) | (this.outputSignals_.requestToSend ? 2 : 0);
            await this.device_.controlTransferOut({
                'requestType': 'class',
                'recipient': 'interface',
                'request': $d2bbb828b377f05f$var$kSetControlLineState,
                'value': value,
                'index': this.controlInterface_.interfaceNumber
            });
        }
        if (signals.break !== undefined) {
            // The SendBreak command expects to be given a duration for how long the
            // break signal should be asserted. Passing 0xFFFF enables the signal
            // until 0x0000 is send.
            //
            // Ref: USB CDC specification version 1.1 §6.2.15.
            const value = this.outputSignals_.break ? 0xFFFF : 0x0000;
            await this.device_.controlTransferOut({
                'requestType': 'class',
                'recipient': 'interface',
                'request': $d2bbb828b377f05f$var$kSendBreak,
                'value': value,
                'index': this.controlInterface_.interfaceNumber
            });
        }
    }
    /**
     * Checks the serial options for validity and throws an error if it is
     * not valid
     */ validateOptions() {
        if (!this.isValidBaudRate(this.serialOptions_.baudRate)) throw new RangeError('invalid Baud Rate ' + this.serialOptions_.baudRate);
        if (!this.isValidDataBits(this.serialOptions_.dataBits)) throw new RangeError('invalid dataBits ' + this.serialOptions_.dataBits);
        if (!this.isValidStopBits(this.serialOptions_.stopBits)) throw new RangeError('invalid stopBits ' + this.serialOptions_.stopBits);
        if (!this.isValidParity(this.serialOptions_.parity)) throw new RangeError('invalid parity ' + this.serialOptions_.parity);
    }
    /**
     * Checks the baud rate for validity
     * @param {number} baudRate the baud rate to check
     * @return {boolean} A boolean that reflects whether the baud rate is valid
     */ isValidBaudRate(baudRate) {
        return baudRate % 1 === 0;
    }
    /**
     * Checks the data bits for validity
     * @param {number} dataBits the data bits to check
     * @return {boolean} A boolean that reflects whether the data bits setting is
     * valid
     */ isValidDataBits(dataBits) {
        if (typeof dataBits === 'undefined') return true;
        return $d2bbb828b377f05f$var$kAcceptableDataBits.includes(dataBits);
    }
    /**
     * Checks the stop bits for validity
     * @param {number} stopBits the stop bits to check
     * @return {boolean} A boolean that reflects whether the stop bits setting is
     * valid
     */ isValidStopBits(stopBits) {
        if (typeof stopBits === 'undefined') return true;
        return $d2bbb828b377f05f$var$kAcceptableStopBits.includes(stopBits);
    }
    /**
     * Checks the parity for validity
     * @param {string} parity the parity to check
     * @return {boolean} A boolean that reflects whether the parity is valid
     */ isValidParity(parity) {
        if (typeof parity === 'undefined') return true;
        return $d2bbb828b377f05f$var$kAcceptableParity.includes(parity);
    }
    /**
     * sends the options alog the control interface to set them on the device
     * @return {Promise} a promise that will resolve when the options are set
     */ async setLineCoding() {
        var _a, _b, _c;
        // Ref: USB CDC specification version 1.1 §6.2.12.
        const buffer = new ArrayBuffer(7);
        const view = new DataView(buffer);
        view.setUint32(0, this.serialOptions_.baudRate, true);
        view.setUint8(4, $d2bbb828b377f05f$var$kStopBitsIndexMapping.indexOf((_a = this.serialOptions_.stopBits) !== null && _a !== void 0 ? _a : $d2bbb828b377f05f$var$kDefaultStopBits));
        view.setUint8(5, $d2bbb828b377f05f$var$kParityIndexMapping.indexOf((_b = this.serialOptions_.parity) !== null && _b !== void 0 ? _b : $d2bbb828b377f05f$var$kDefaultParity));
        view.setUint8(6, (_c = this.serialOptions_.dataBits) !== null && _c !== void 0 ? _c : $d2bbb828b377f05f$var$kDefaultDataBits);
        const result = await this.device_.controlTransferOut({
            'requestType': 'class',
            'recipient': 'interface',
            'request': $d2bbb828b377f05f$var$kSetLineCoding,
            'value': 0x00,
            'index': this.controlInterface_.interfaceNumber
        }, buffer);
        if (result.status != 'ok') throw new DOMException('NetworkError', 'Failed to set line coding.');
    }
}
/** implementation of the global navigator.serial object */ class $d2bbb828b377f05f$var$Serial {
    /**
     * Requests permission to access a new port.
     *
     * @param {SerialPortRequestOptions} options
     * @param {SerialPolyfillOptions} polyfillOptions
     * @return {Promise<SerialPort>}
     */ async requestPort(options, polyfillOptions) {
        polyfillOptions = Object.assign(Object.assign({}, $d2bbb828b377f05f$var$kDefaultPolyfillOptions), polyfillOptions);
        const usbFilters = [];
        if (options && options.filters) for (const filter of options.filters){
            const usbFilter = {
                classCode: polyfillOptions.usbControlInterfaceClass
            };
            if (filter.usbVendorId !== undefined) usbFilter.vendorId = filter.usbVendorId;
            if (filter.usbProductId !== undefined) usbFilter.productId = filter.usbProductId;
            usbFilters.push(usbFilter);
        }
        if (usbFilters.length === 0) usbFilters.push({
            classCode: polyfillOptions.usbControlInterfaceClass
        });
        const device = await navigator.usb.requestDevice({
            'filters': usbFilters
        });
        const port = new $d2bbb828b377f05f$export$237d90817cb05a2f(device, polyfillOptions);
        return port;
    }
    /**
     * Get the set of currently available ports.
     *
     * @param {SerialPolyfillOptions} polyfillOptions Polyfill configuration that
     * should be applied to these ports.
     * @return {Promise<SerialPort[]>} a promise that is resolved with a list of
     * ports.
     */ async getPorts(polyfillOptions) {
        polyfillOptions = Object.assign(Object.assign({}, $d2bbb828b377f05f$var$kDefaultPolyfillOptions), polyfillOptions);
        const devices = await navigator.usb.getDevices();
        const ports = [];
        devices.forEach((device)=>{
            try {
                const port = new $d2bbb828b377f05f$export$237d90817cb05a2f(device, polyfillOptions);
                ports.push(port);
            } catch (e) {
            // Skip unrecognized port.
            }
        });
        return ports;
    }
}
const $d2bbb828b377f05f$export$6c2c9a00e27c07e8 = new $d2bbb828b377f05f$var$Serial();


const $382e02c9bbd5d50b$var$baudrates = document.getElementById("baudrates");
const $382e02c9bbd5d50b$var$connectButton = document.getElementById("connectButton");
const $382e02c9bbd5d50b$var$disconnectButton = document.getElementById("disconnectButton");
const $382e02c9bbd5d50b$var$eraseButton = document.getElementById("eraseButton");
const $382e02c9bbd5d50b$var$programButton = document.getElementById("programButton");
const $382e02c9bbd5d50b$var$filesDiv = document.getElementById("files");
const $382e02c9bbd5d50b$var$terminal = document.getElementById("terminal");
const $382e02c9bbd5d50b$var$programDiv = document.getElementById("program");
const $382e02c9bbd5d50b$var$lblBaudrate = document.getElementById("lblBaudrate");
const $382e02c9bbd5d50b$var$lblConnTo = document.getElementById("lblConnTo");
const $382e02c9bbd5d50b$var$table = document.getElementById("fileTable");
const $382e02c9bbd5d50b$var$alertDiv = document.getElementById("alertDiv");
const $382e02c9bbd5d50b$var$serialLib = !navigator.serial && navigator.usb ? (0, $d2bbb828b377f05f$export$6c2c9a00e27c07e8) : navigator.serial;
// 縦幅を15行に固定し、自動改行お任せモードをONにしたターミナル初期化
const $382e02c9bbd5d50b$var$term = new Terminal({
    cols: 100,
    rows: 15,
    convertEol: true
});
$382e02c9bbd5d50b$var$term.open($382e02c9bbd5d50b$var$terminal);
let $382e02c9bbd5d50b$var$device = null;
let $382e02c9bbd5d50b$var$deviceInfo = null;
let $382e02c9bbd5d50b$var$transport;
let $382e02c9bbd5d50b$var$chip = null;
let $382e02c9bbd5d50b$var$esploader;
// 初期状態のUI制御
$382e02c9bbd5d50b$var$disconnectButton.style.display = "none";
$382e02c9bbd5d50b$var$eraseButton.style.display = "none";
$382e02c9bbd5d50b$var$filesDiv.style.display = "none";
function $382e02c9bbd5d50b$var$handleFileSelect(evt) {
    const file = evt.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev)=>{
        if (ev.target.result instanceof ArrayBuffer) evt.target.data = new Uint8Array(ev.target.result);
        else evt.target.data = ev.target.result;
    };
    reader.readAsArrayBuffer(file);
}
const $382e02c9bbd5d50b$var$espLoaderTerminal = {
    clean () {
        $382e02c9bbd5d50b$var$term.clear();
    },
    writeLine (data) {
        $382e02c9bbd5d50b$var$term.writeln(data);
    },
    write (data) {
        $382e02c9bbd5d50b$var$term.write(data);
    }
};
function $382e02c9bbd5d50b$var$createFileInputRow() {
    const rowCount = $382e02c9bbd5d50b$var$table.rows.length;
    const row = $382e02c9bbd5d50b$var$table.insertRow(rowCount);
    const cell1 = row.insertCell(0);
    const element1 = document.createElement("input");
    element1.type = "file";
    element1.accept = ".zip";
    element1.id = "selectFile" + rowCount;
    element1.name = "selected_File" + rowCount;
    element1.addEventListener("change", $382e02c9bbd5d50b$var$handleFileSelect, false);
    cell1.appendChild(element1);
    const cell2 = row.insertCell(1);
    cell2.classList.add("progress-cell");
    cell2.style.display = "none";
    cell2.innerHTML = `<progress value="0" max="100"></progress>`;
}
// ----------------------------------------------------
// 1. Program (書き込み) ロジック
// ----------------------------------------------------
$382e02c9bbd5d50b$var$connectButton.onclick = async ()=>{
    try {
        $382e02c9bbd5d50b$var$device = await (0, $d3c0f20c363d2d06$export$8c99db40de14d118)(true);
        $382e02c9bbd5d50b$var$deviceInfo = $382e02c9bbd5d50b$var$device.getInfo();
        const vid = $382e02c9bbd5d50b$var$deviceInfo.usbVendorId;
        const pid = $382e02c9bbd5d50b$var$deviceInfo.usbProductId;
        $382e02c9bbd5d50b$var$term.writeln(`USB device: VID=0x${vid.toString(16).padStart(4, "0")} ` + `PID=0x${pid.toString(16).padStart(4, "0")}`);
        if (vid !== 0x2886 || pid !== 0x0045) {
            $382e02c9bbd5d50b$var$term.writeln("ERROR: XIAO nRF52840 Bootloader\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
            $382e02c9bbd5d50b$var$term.writeln("RESET\u3092\u7D20\u65E9\u304F2\u56DE\u62BC\u3057\u3066Bootloader\u30E2\u30FC\u30C9\u306B\u3057\u3066\u304F\u3060\u3055\u3044");
            return;
        }
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
        $382e02c9bbd5d50b$var$term.writeln("Ready for Bootloader 0.11.0 update.");
        $382e02c9bbd5d50b$var$term.writeln("==============================");
        // ファイル選択欄を表示
        $382e02c9bbd5d50b$var$filesDiv.style.display = "block";
        $382e02c9bbd5d50b$var$programDiv.style.display = "block";
        // 接続後のUI
        $382e02c9bbd5d50b$var$lblBaudrate.style.display = "none";
        $382e02c9bbd5d50b$var$baudrates.style.display = "none";
        $382e02c9bbd5d50b$var$connectButton.style.display = "none";
        $382e02c9bbd5d50b$var$disconnectButton.style.display = "initial";
        $382e02c9bbd5d50b$var$lblConnTo.innerHTML = "Connected: XIAO nRF52840 Bootloader";
        $382e02c9bbd5d50b$var$lblConnTo.style.display = "block";
    } catch (e) {
        console.error(e);
        $382e02c9bbd5d50b$var$term.writeln(`ERROR: ${e.message}`);
    }
};
$382e02c9bbd5d50b$var$eraseButton.onclick = async ()=>{
    $382e02c9bbd5d50b$var$eraseButton.disabled = true;
    try {
        await $382e02c9bbd5d50b$var$esploader.eraseFlash();
    } catch (e) {
        console.error(e);
        $382e02c9bbd5d50b$var$term.writeln(`Error: ${e.message}`);
    } finally{
        $382e02c9bbd5d50b$var$eraseButton.disabled = false;
    }
};
function $382e02c9bbd5d50b$var$cleanUp() {
    $382e02c9bbd5d50b$var$device = null;
    $382e02c9bbd5d50b$var$deviceInfo = null;
    $382e02c9bbd5d50b$var$transport = null;
    $382e02c9bbd5d50b$var$chip = null;
}
$382e02c9bbd5d50b$var$disconnectButton.onclick = async ()=>{
    if ($382e02c9bbd5d50b$var$transport) await $382e02c9bbd5d50b$var$transport.disconnect();
    $382e02c9bbd5d50b$var$term.reset();
    $382e02c9bbd5d50b$var$lblBaudrate.style.display = "initial";
    $382e02c9bbd5d50b$var$baudrates.style.display = "initial";
    $382e02c9bbd5d50b$var$connectButton.style.display = "initial";
    $382e02c9bbd5d50b$var$disconnectButton.style.display = "none";
    $382e02c9bbd5d50b$var$eraseButton.style.display = "none";
    $382e02c9bbd5d50b$var$lblConnTo.style.display = "none";
    $382e02c9bbd5d50b$var$filesDiv.style.display = "none";
    $382e02c9bbd5d50b$var$alertDiv.style.display = "none";
    $382e02c9bbd5d50b$var$cleanUp();
};
// ----------------------------------------------------
// 2. 共通プログラム検証
// ----------------------------------------------------
function $382e02c9bbd5d50b$var$validateProgramInputs() {
    const rowCount = $382e02c9bbd5d50b$var$table.rows.length;
    let row;
    let fileData = null;
    for(let index = 0; index < rowCount; index++){
        row = $382e02c9bbd5d50b$var$table.rows[index];
        if (!row.cells[0] || !row.cells[0].childNodes[0]) return "No file field available!";
        const fileObj = row.cells[0].childNodes[0];
        fileData = fileObj.data;
        if (fileData == null) return "No file selected!";
    }
    return "success";
}
$382e02c9bbd5d50b$var$programButton.onclick = async ()=>{
    // 二重押し防止
    $382e02c9bbd5d50b$var$programButton.disabled = true;
    let progressBar = null;
    let progressRow = null;
    let writeCompleted = false;
    try {
        $382e02c9bbd5d50b$var$alertDiv.style.display = "none";
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
        $382e02c9bbd5d50b$var$term.writeln("Starting Bootloader DFU");
        $382e02c9bbd5d50b$var$term.writeln("==============================");
        const dfu = new (0, $524f1288a2f15fe5$export$6f8da3a76fb818d)($382e02c9bbd5d50b$var$device, (msg)=>$382e02c9bbd5d50b$var$term.writeln(msg));
        try {
            await dfu.start();
            // ------------------------------------------------
            // START: SoftDevice + Bootloader
            // ------------------------------------------------
            $382e02c9bbd5d50b$var$term.writeln("Sending DFU START...");
            await dfu.sendStartDfu(3, softdeviceSize, bootloaderSize, 0 // Application size
            );
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
            $382e02c9bbd5d50b$var$term.writeln("==============================");
            $382e02c9bbd5d50b$var$term.writeln("Bootloader Update Complete");
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
        if (!writeCompleted && progressRow) progressRow.cells[1].style.display = "none";
        $382e02c9bbd5d50b$var$programButton.disabled = false;
    }
};
function $382e02c9bbd5d50b$var$createBootloaderProgressRow() {
    const row = $382e02c9bbd5d50b$var$table.insertRow($382e02c9bbd5d50b$var$table.rows.length);
    const cell1 = row.insertCell(0);
    cell1.textContent = "Bootloader 0.11.0 update file will be downloaded automatically.";
    const cell2 = row.insertCell(1);
    cell2.classList.add("progress-cell");
    cell2.style.display = "none";
    cell2.innerHTML = `<progress value="0" max="100"></progress>`;
}
$382e02c9bbd5d50b$var$createBootloaderProgressRow();


//# sourceMappingURL=typescript.b1face31.js.map
