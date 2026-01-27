import Foundation
import AudioToolbox
import CoreAudio
import AVFoundation

final class HALSystemAudioCapture {

    enum CaptureError: Error {
        case deviceNotFound
        case audioUnitInitFailed
        case streamFormatFailed
        case converterFailed
    }

    // MARK: - Public API

    var onAudioData: ((Data) -> Void)?

    fileprivate var audioUnit: AudioUnit?
    private var deviceID: AudioDeviceID = 0
    fileprivate var converter: AVAudioConverter?
    
    // Target format: 16kHz Mono Int16
    fileprivate let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    
    // Captured format (device native)
    fileprivate var capturedFormat: AVAudioFormat?

    func start(virtualDeviceUID: String) throws {
        try setupDevice(uid: virtualDeviceUID)
        try setupAudioUnit()
        try startAudioUnit()
    }

    func stop() {
        if let audioUnit = audioUnit {
            AudioOutputUnitStop(audioUnit)
            AudioUnitUninitialize(audioUnit)
        }
        converter = nil
    }

    // MARK: - Device Discovery
    
    static func listAllDevices() {
        var propSize: UInt32 = 0
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &propSize)
        
        let deviceCount = Int(propSize) / MemoryLayout<AudioDeviceID>.size
        var devices = [AudioDeviceID](repeating: 0, count: deviceCount)
        
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &propSize, &devices)
        
        Logger.log("========== AVAILABLE AUDIO DEVICES ==========", level: .warning)
        
        for deviceID in devices {
            var deviceName: CFString = "" as CFString
            var deviceUID: CFString = "" as CFString
            var size = UInt32(MemoryLayout<CFString>.size)
            
            var nameAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDeviceNameCFString,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            
            var uidAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDeviceUID,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            
            AudioObjectGetPropertyData(deviceID, &nameAddr, 0, nil, &size, &deviceName)
            AudioObjectGetPropertyData(deviceID, &uidAddr, 0, nil, &size, &deviceUID)
            
            // Get input channel count
            var inputAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreamConfiguration,
                mScope: kAudioDevicePropertyScopeInput,
                mElement: kAudioObjectPropertyElementMain
            )
            
            var inputSize: UInt32 = 0
            AudioObjectGetPropertyDataSize(deviceID, &inputAddr, 0, nil, &inputSize)
            
            // Actually parsing stream config is complex because AudioBufferList is variable length
            // For rigorous channel count:
            var inputChannels: UInt32 = 0
            if inputSize > 0 {
                 let rawPtr = UnsafeMutableRawPointer.allocate(byteCount: Int(inputSize), alignment: MemoryLayout<AudioBufferList>.alignment)
                 defer { rawPtr.deallocate() }
                 
                 let status = AudioObjectGetPropertyData(deviceID, &inputAddr, 0, nil, &inputSize, rawPtr)
                 
                 if status == noErr {
                     let bufferListPtr = rawPtr.bindMemory(to: AudioBufferList.self, capacity: 1)
                     let buffers = UnsafeMutableAudioBufferListPointer(bufferListPtr)
                     for buffer in buffers {
                         inputChannels += buffer.mNumberChannels
                     }
                 }
            }
            
            let hasInputs = inputChannels > 0 ? "✅ HAS \(inputChannels) INPUTS" : "❌ NO INPUTS"
            
            Logger.log("  Name: '\(deviceName)'", level: .warning)
            Logger.log("  UID:  '\(deviceUID)'", level: .warning)
            Logger.log("  \(hasInputs)", level: .warning)
            Logger.log("  ---", level: .warning)
        }
        
        Logger.log("=============================================", level: .warning)
    }

    // MARK: - Device Lookup

    private func setupDevice(uid: String) throws {
        var uidCF = uid as CFString
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        
        // Try exact UID match first
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        var status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<CFString>.size), &uidCF, &size, &deviceID)
        
        if status != noErr || deviceID == 0 {
            Logger.log("HAL: UID '\(uid)' not found or invalid. Searching by name 'BlackHole'...", level: .warning)
            // Fallback: Name Search
            try findDeviceByName(searchName: "BlackHole")
        } else {
             Logger.log("HAL: Found device by UID: \(uid) (ID: \(deviceID))", level: .info)
        }
        
        // Verify it works
        verifyDeviceConfiguration(deviceID)
    }
    
    private func findDeviceByName(searchName: String) throws {
        var propSize: UInt32 = 0
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &propSize)
        let deviceCount = Int(propSize) / MemoryLayout<AudioDeviceID>.size
        var devices = [AudioDeviceID](repeating: 0, count: deviceCount)
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &propSize, &devices)
        
        for id in devices {
             var name: CFString = "" as CFString
             var size = UInt32(MemoryLayout<CFString>.size)
             var nameAddr = AudioObjectPropertyAddress(
                 mSelector: kAudioDevicePropertyDeviceNameCFString,
                 mScope: kAudioObjectPropertyScopeGlobal,
                 mElement: kAudioObjectPropertyElementMain
             )
             AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &size, &name)
             let nameStr = name as String
             
             if nameStr.contains(searchName) {
                 // Check inputs
                 var inputChannels: UInt32 = 0
                 var inputAddr = AudioObjectPropertyAddress(
                     mSelector: kAudioDevicePropertyStreamConfiguration,
                     mScope: kAudioDevicePropertyScopeInput,
                     mElement: kAudioObjectPropertyElementMain
                 )
                 var inputSize: UInt32 = 0
                 AudioObjectGetPropertyDataSize(id, &inputAddr, 0, nil, &inputSize)
                 
                 if inputSize > 0 {
                      let bufferListPointer = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
                      defer { bufferListPointer.deallocate() }
                      AudioObjectGetPropertyData(id, &inputAddr, 0, nil, &inputSize, bufferListPointer)
                      let buffers = UnsafeMutableAudioBufferListPointer(bufferListPointer)
                      for buffer in buffers {
                          inputChannels += buffer.mNumberChannels
                      }
                 }
                 
                 if inputChannels > 0 {
                     Logger.log("HAL: Fallback found '\(nameStr)' (ID: \(id)) with \(inputChannels) inputs", level: .info)
                     self.deviceID = id
                     return
                 }
             }
        }
        throw CaptureError.deviceNotFound
    }

    private func verifyDeviceConfiguration(_ deviceID: AudioDeviceID) {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        
        var propSize: UInt32 = 0
        AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &propSize)
        
        if propSize == 0 {
            Logger.log("HAL: ❌ CRITICAL: Device has NO INPUT CHANNELS!", level: .error)
            return
        }
        
        let bufferListPointer = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
        defer { bufferListPointer.deallocate() }
        
        AudioObjectGetPropertyData(deviceID, &address, 0, nil, &propSize, bufferListPointer)
        
        let buffers = UnsafeMutableAudioBufferListPointer(bufferListPointer)
        var totalChannels: UInt32 = 0
        for buffer in buffers {
            totalChannels += buffer.mNumberChannels
        }
        
        Logger.log("HAL: ✅ Device verification: \(totalChannels) input channels", level: .info)
        
        if totalChannels == 0 {
            Logger.log("HAL: ❌ FATAL: Device has 0 input channels. Cannot capture from output-only device!", level: .error)
        }
    }

    // MARK: - Audio Unit Setup

    private func setupAudioUnit() throws {
        var desc = AudioComponentDescription(
            componentType: kAudioUnitType_Output,
            componentSubType: kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple,
            componentFlags: 0,
            componentFlagsMask: 0
        )

        guard let component = AudioComponentFindNext(nil, &desc) else {
            throw CaptureError.audioUnitInitFailed
        }

        var unit: AudioUnit?
        let status = AudioComponentInstanceNew(component, &unit)
        guard status == noErr, let audioUnit = unit else {
            throw CaptureError.audioUnitInitFailed
        }

        self.audioUnit = audioUnit

        // Enable input capture (from the device)
        var enableIO: UInt32 = 1
        AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Input, // Enable Input Scope (Element 1)
            1,
            &enableIO,
            UInt32(MemoryLayout<UInt32>.size)
        )

        // Disable output (to the device)
        var disableIO: UInt32 = 0
        AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Output, // Disable Output Scope (Element 0)
            0,
            &disableIO,
            UInt32(MemoryLayout<UInt32>.size)
        )

        // Attach device
        var deviceID = self.deviceID
        AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )



        // --- NEW LOGIC: Use Device Native Format for AU, then Convert ---
        
        // Get the device's actual current stream format
        var deviceFormat = AudioStreamBasicDescription()
        var propertySize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        
        // We need to get the stream format of the Input Scope of the AU (Element 1)
        // Which should default to the Hardware Format
        let getFormatStatus = AudioUnitGetProperty(
            audioUnit,
            kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Input,
            1,
            &deviceFormat,
            &propertySize
        )
        
        guard getFormatStatus == noErr else {
             throw CaptureError.streamFormatFailed
        }
        
        Logger.log("HAL Device Native Format: \(deviceFormat.mSampleRate)Hz, \(deviceFormat.mChannelsPerFrame)ch, format=\(deviceFormat.mFormatID)", level: .info)

        if deviceFormat.mSampleRate == 0 {
            Logger.log("HAL: Device format has ZERO sample rate! Stream may be inactive.", level: .error)
            throw CaptureError.streamFormatFailed
        }
        

        
        if let avFormat = AVAudioFormat(streamDescription: &deviceFormat) {
            self.capturedFormat = avFormat
            Logger.log("HAL Device Native Format: \(deviceFormat.mSampleRate)Hz, \(deviceFormat.mChannelsPerFrame)ch (AVFormat: \(avFormat))", level: .info)
        } else {
             Logger.log("Failed to create AVAudioFormat from device format", level: .error)
             throw CaptureError.streamFormatFailed
        }

        // DIAGNOSTIC: Check if device is actually running
        var isRunning: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(
             mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
             mScope: kAudioObjectPropertyScopeGlobal,
             mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &isRunning)
        AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &isRunning)
        Logger.log("HAL: Device (ID: \(deviceID)) isRunning: \(isRunning)", level: .info)
        
        // Set the AU Output (Scope Output, Element 1) to match the Input (Device Native)
        
        // Set the AU Output (Scope Output, Element 1) to match the Input (Device Native)
        // This ensures the AU just passes data through without trying to resampling itself (which often fails)
        let setFormatStatus = AudioUnitSetProperty(
            audioUnit,
            kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Output,
            1, 
            &deviceFormat,
            UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        )

        guard setFormatStatus == noErr else {
            throw CaptureError.streamFormatFailed
        }
        
        // Initialize the AVAudioConverter
        // Convert from Device Format (Float32 usually) to Target (16kHz Int16)
        if let sourceFormat = AVAudioFormat(streamDescription: &deviceFormat) {
            self.converter = AVAudioConverter(from: sourceFormat, to: targetFormat)
            // Fix: Do NOT force channel 0. Let converter mix down if needed.
            // self.converter?.channelMap = [0] 
        } else {
            throw CaptureError.streamFormatFailed
        }

        // Set Input Callback (to receive data)
        var callback = AURenderCallbackStruct(
            inputProc: renderCallback,
            inputProcRefCon: UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        )

        AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_SetInputCallback, // Correct Property for Input
            kAudioUnitScope_Global,
            0,
            &callback,
            UInt32(MemoryLayout<AURenderCallbackStruct>.size)
        )

        let initStatus = AudioUnitInitialize(audioUnit)
        guard initStatus == noErr else {
             throw CaptureError.audioUnitInitFailed
        }
    }

    private func startAudioUnit() throws {
        guard let audioUnit = audioUnit else { throw CaptureError.audioUnitInitFailed }
        let status = AudioOutputUnitStart(audioUnit)
        guard status == noErr else { throw CaptureError.audioUnitInitFailed }
    }
}

// MARK: - Render Callback

private func renderCallback(
    inRefCon: UnsafeMutableRawPointer,
    ioActionFlags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
    inTimeStamp: UnsafePointer<AudioTimeStamp>,
    inBusNumber: UInt32,
    inNumberFrames: UInt32,
    ioData: UnsafeMutablePointer<AudioBufferList>?
) -> OSStatus {

    let capture = Unmanaged<HALSystemAudioCapture>
        .fromOpaque(inRefCon)
        .takeUnretainedValue()

    guard let audioUnit = capture.audioUnit,
          let format = capture.capturedFormat else {
        return kAudioUnitErr_Uninitialized
    }
    
    // Log throttling
    struct Static { static var callbackCount = 0 }
    Static.callbackCount += 1
    let shouldLog = Static.callbackCount <= 10 || Static.callbackCount % 100 == 0
    
    if shouldLog {
         Logger.log("HAL: Callback #\(Static.callbackCount), frames=\(inNumberFrames), bus=\(inBusNumber)", level: .info)
    }

    // Manual Buffer Allocation to avoid AVAudioPCMBuffer quirks (Fix for error -50)
    let channelCount = format.channelCount // e.g. 2
    let isInterleaved = format.isInterleaved // e.g. true for BlackHole
    let bytesPerFrame = format.streamDescription.pointee.mBytesPerFrame // e.g. 8 for 2ch float32 interleaved
    let bufferSizeBytes = Int(inNumberFrames) * Int(bytesPerFrame)
    
    // We need an AudioBufferList.
    // Since we are inside a sensitive callback, we prefer stack or pre-allocated. 
    // But swift makes stack ABL hard. We will use a singular malloc for the data.
    
    // Allocate data buffer (this is fast enough usually, or pre-allocate in real-time apps)
    // For safety and correctness, we alloc here.
    let dataPtr = UnsafeMutableRawPointer.allocate(byteCount: bufferSizeBytes, alignment: 16)
    defer { dataPtr.deallocate() }
    
    // Construct AudioBufferList manually
    var bufferList = AudioBufferList()
    bufferList.mNumberBuffers = 1 // Assuming interleaved for now as logs confirmed it. 
    // If Deinterleaved, we need loop. 
    // Logs said: "Float32, interleaved". So 1 buffer.
    
    bufferList.mBuffers.mNumberChannels = channelCount
    bufferList.mBuffers.mDataByteSize = UInt32(bufferSizeBytes)
    bufferList.mBuffers.mData = dataPtr
    
    // Call Render
    // We must pass the pointer to the struct
    let status = AudioUnitRender(
        audioUnit,
        ioActionFlags,
        inTimeStamp,
        1, // Input Element
        inNumberFrames,
        &bufferList
    )
    
    guard status == noErr else {
        Logger.log("HAL: AudioUnitRender FAILED with status: \(status)", level: .error)
        return status
    }
    
    // Success! Now we have data in dataPtr.
    // We need to convert it using AVAudioConverter.
    
    // Wrap data in a buffer for the converter
    guard let inputBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: inNumberFrames) else {
        return kAudioUnitErr_FormatNotSupported
    }
    inputBuffer.frameLength = inNumberFrames
    
    // Copy data to AVAudioPCMBuffer
    if let dest = inputBuffer.floatChannelData?[0] {
        // floatChannelData is UnsafeMutablePointer<Float>
        // dataPtr is void.
        // Assuming Float32 interleaved -> directly copy bytes
        let destRaw = UnsafeMutableRawPointer(dest)
        destRaw.copyMemory(from: dataPtr, byteCount: bufferSizeBytes)
    } else {
        return kAudioUnitErr_FormatNotSupported
    }
    
    // Proceed with conversion (existing logic)
    
    // 1. Diagnostics
    if shouldLog {
        let floats = dataPtr.assumingMemoryBound(to: Float.self)
        var maxSample: Float = 0.0
        let checkCount = min(100, Int(inNumberFrames) * Int(channelCount))
        for i in 0..<checkCount {
            maxSample = max(maxSample, abs(floats[i]))
        }
        if maxSample < 0.0001 {
             Logger.log("HAL: ⚠️  Captured Silence (RMS < 0.0001)", level: .warning)
        } else {
             Logger.log("HAL: ✅ Audio Signal Present (Max: \(maxSample))", level: .info)
        }
    }
    
    // 2. Output Buffer
    let ratio = 16000.0 / format.sampleRate
    let outputFrameCapacity = AVAudioFrameCount(Double(inNumberFrames) * ratio * 2.0) + 100
    
    guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: capture.targetFormat, frameCapacity: outputFrameCapacity) else {
        return noErr
    }
    
    var error: NSError?
    guard let converter = capture.converter else { return noErr }
    
    var inputBufferUsed = false
    let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
        if inputBufferUsed {
            outStatus.pointee = .noDataNow
            return nil
        }
        inputBufferUsed = true
        outStatus.pointee = .haveData
        return inputBuffer
    }
    
    converter.convert(to: outputBuffer, error: &error, withInputFrom: inputBlock)
    
    if let error = error {
         Logger.log("HAL Convert Error: \(error)", level: .error)
         return noErr
    }
    
    // 3. Forward Data
    if outputBuffer.frameLength > 0, let int16Data = outputBuffer.int16ChannelData {
         let byteCount = Int(outputBuffer.frameLength) * MemoryLayout<Int16>.size
         let pcmData = Data(bytes: int16Data[0], count: byteCount)
         
         // capture.onAudioData?(pcmData)
         // Duplicate call removed, just use the one below
         
         capture.onAudioData?(pcmData)
         
         // Success log - commented out to prevent spam (200Hz)
         // if shouldLog {
         //    Logger.log("HAL -> Delegate: Sent \(byteCount) bytes", level: .info)
         // }
    }
    
    return noErr
}
