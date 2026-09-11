import Capacitor
import AVFoundation

// WKWebView's getUserMedia(audio) puts AVAudioSession into .playAndRecord /
// .voiceChat — Apple's setting meant for two-way VoIP calls, which engages
// hardware echo cancellation. That configuration doesn't get undone just
// because the MediaStream's tracks are stopped, so any audio played back
// afterwards (e.g. reviewing your own recorded voice) keeps running
// through the voice-chat DSP path and comes out sounding echoey/processed.
// This resets the session to plain playback before that happens.
@objc(AudioSessionFixPlugin)
public class AudioSessionFixPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioSessionFixPlugin"
    public let jsName = "AudioSessionFix"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "resetForPlayback", returnType: CAPPluginReturnPromise)
    ]

    @objc func resetForPlayback(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true, options: [])
            call.resolve()
        } catch {
            call.reject("Failed to reset audio session: \(error.localizedDescription)")
        }
    }
}
