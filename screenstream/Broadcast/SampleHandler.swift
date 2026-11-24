import Network
import ReplayKit
import VideoToolbox
import os

// Streams the whole screen as H.264 to TCP clients on port 8400, as soon as each frame is encoded.
//
// Wire format, phone to client: one message per frame, a 4-byte big-endian length, then the frame as
// Annex B (an AUD, then SPS and PPS on keyframes, then the slices). Client to phone: any "K" byte asks
// for a keyframe. A new client gets a keyframe of the current screen at once, even when nothing moves.
final class SampleHandler: RPBroadcastSampleHandler {
    static let port: NWEndpoint.Port = 8400
    static let bitrate = 6_000_000

    private let queue = DispatchQueue(label: "screenstream")
    private let log = Logger(subsystem: "dev.raygen.ScreenStream", category: "broadcast")
    private var listener: NWListener?
    private var clients: [ObjectIdentifier: Client] = [:]
    private var session: VTCompressionSession?
    private var sessionWidth = 0
    private var sessionHeight = 0
    private var last: CVPixelBuffer?  // the latest screen, re-encoded for new clients and after the screen stops
    private var lastFrameTime = DispatchTime.now()
    private var forceKey = true
    private var flush: DispatchWorkItem?
    private var keepalive: DispatchSourceTimer?

    final class Client {
        let connection: NWConnection
        var queuedBytes = 0
        var needsKey = true
        init(_ connection: NWConnection) { self.connection = connection }
    }

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        queue.async { [self] in
            listen()
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + 2, repeating: 2)
            timer.setEventHandler { [weak self] in self?.refresh(olderThan: 2) }
            timer.resume()
            keepalive = timer
        }
    }

    override func broadcastFinished() {
        queue.sync {
            keepalive?.cancel()
            listener?.cancel()
            clients.values.forEach { $0.connection.cancel() }
            clients.removeAll()
            if let session { VTCompressionSessionInvalidate(session) }
            session = nil
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        queue.async { [self] in
            last = pixels
            guard !clients.isEmpty else { return }
            encode(pixels)
            // The last frame before the screen goes still is sent again shortly after, so a decoder that
            // holds one frame back still shows the final screen.
            flush?.cancel()
            let item = DispatchWorkItem { [weak self] in self?.refresh(olderThan: 0.1) }
            flush = item
            queue.asyncAfter(deadline: .now() + 0.12, execute: item)
        }
    }

    // MARK: - Network

    private func listen() {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        params.allowLocalEndpointReuse = true
        do {
            let listener = try NWListener(using: params, on: Self.port)
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.stateUpdateHandler = { [weak self] state in
                self?.log.info("listener \(String(describing: state), privacy: .public)")
                if case .failed = state {  // e.g. the port was briefly still taken; try again
                    self?.queue.asyncAfter(deadline: .now() + 1) { self?.listen() }
                }
            }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            log.error("cannot listen on \(Self.port.rawValue): \(error.localizedDescription, privacy: .public)")
            queue.asyncAfter(deadline: .now() + 1) { [weak self] in self?.listen() }
        }
    }

    private func accept(_ connection: NWConnection) {
        let client = Client(connection)
        let id = ObjectIdentifier(client)
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.clients[id] = nil
            default: break
            }
        }
        connection.start(queue: queue)
        clients[id] = client
        receive(client, id)
        forceKey = true
        if let last { encode(last) }
    }

    private func receive(_ client: Client, _ id: ObjectIdentifier) {
        client.connection.receive(minimumIncompleteLength: 1, maximumLength: 64) { [weak self] data, _, done, error in
            guard let self else { return }
            if let data, data.contains(UInt8(ascii: "K")) {
                forceKey = true
                if let last { encode(last) }
            }
            if done || error != nil {
                client.connection.cancel()
                clients[id] = nil
            } else {
                receive(client, id)
            }
        }
    }

    private func send(_ frame: Data, key: Bool) {
        var message = Data(count: 4)
        message.withUnsafeMutableBytes { $0.storeBytes(of: UInt32(frame.count).bigEndian, as: UInt32.self) }
        message.append(frame)
        for client in clients.values {
            // A client that falls behind skips frames until the next keyframe instead of queueing them
            // (the extension may use only about 50 MB).
            if client.queuedBytes > 1 << 20 { client.needsKey = true }
            if client.needsKey && !key { forceKey = true; continue }
            client.needsKey = false
            let size = message.count
            client.queuedBytes += size
            client.connection.send(content: message, completion: .contentProcessed { [weak self] _ in
                self?.queue.async { client.queuedBytes -= size }
            })
        }
    }

    // MARK: - Encoding

    private func refresh(olderThan seconds: Double) {
        guard !clients.isEmpty, let last else { return }
        let age = Double(DispatchTime.now().uptimeNanoseconds - lastFrameTime.uptimeNanoseconds) / 1e9
        if age >= seconds { encode(last) }
    }

    private func encode(_ pixels: CVPixelBuffer) {
        let width = CVPixelBufferGetWidth(pixels), height = CVPixelBufferGetHeight(pixels)
        if session == nil || sessionWidth != width || sessionHeight != height {
            guard let made = makeSession(width: width, height: height) else { return }
            session = made
            sessionWidth = width
            sessionHeight = height
            forceKey = true
        }
        guard let session else { return }
        lastFrameTime = .now()
        let props: CFDictionary? = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        forceKey = false
        let pts = CMClockGetTime(CMClockGetHostTimeClock())
        VTCompressionSessionEncodeFrame(
            session, imageBuffer: pixels, presentationTimeStamp: pts, duration: .invalid,
            frameProperties: props, infoFlagsOut: nil
        ) { [weak self] status, _, sample in
            guard status == noErr, let sample, let (frame, key) = Self.annexB(sample) else { return }
            self?.queue.async { self?.send(frame, key: key) }
        }
    }

    private func makeSession(width: Int, height: Int) -> VTCompressionSession? {
        if let session { VTCompressionSessionInvalidate(session) }
        let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary
        var made: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
            encoderSpecification: spec, imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil, compressionSessionOut: &made)
        guard status == noErr, let made else {
            log.error("VTCompressionSessionCreate failed: \(status)")
            return nil
        }
        let set = { (key: CFString, value: Any) in _ = VTSessionSetProperty(made, key: key, value: value as CFTypeRef) }
        set(kVTCompressionPropertyKey_RealTime, true)
        set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel)
        set(kVTCompressionPropertyKey_AllowFrameReordering, false)
        set(kVTCompressionPropertyKey_AverageBitRate, Self.bitrate)
        set(kVTCompressionPropertyKey_ExpectedFrameRate, 60)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, 600)
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 10)
        VTCompressionSessionPrepareToEncodeFrames(made)
        log.info("encoder \(width)x\(height)")
        return made
    }

    /// The encoded frame as Annex B with an AUD first, and whether it is a keyframe.
    static func annexB(_ sample: CMSampleBuffer) -> (Data, Bool)? {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let key = !((attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
        let startCode: [UInt8] = [0, 0, 0, 1]
        var out = Data(startCode + [0x09, 0xF0])
        if key, let format = CMSampleBufferGetFormatDescription(sample) {
            var count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
                parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
            for i in 0..<count {
                var pointer: UnsafePointer<UInt8>?
                var size = 0
                CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    format, parameterSetIndex: i, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size,
                    parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
                if let pointer {
                    out.append(contentsOf: startCode)
                    out.append(pointer, count: size)
                }
            }
        }
        let total = CMBlockBufferGetDataLength(block)
        var avcc = [UInt8](repeating: 0, count: total)
        guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: total, destination: &avcc) == noErr else {
            return nil
        }
        var i = 0
        while i + 4 <= total {  // AVCC: 4-byte big-endian lengths -> Annex B start codes
            let n = Int(avcc[i]) << 24 | Int(avcc[i + 1]) << 16 | Int(avcc[i + 2]) << 8 | Int(avcc[i + 3])
            i += 4
            guard n > 0, i + n <= total else { break }
            out.append(contentsOf: startCode)
            out.append(contentsOf: avcc[i..<(i + n)])
            i += n
        }
        return (out, key)
    }
}
