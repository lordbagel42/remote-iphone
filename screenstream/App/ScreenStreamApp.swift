import ReplayKit
import SwiftUI

// The app only starts the broadcast: tapping the picker opens iOS's sheet, whose Start Broadcast
// runs the extension. `iphone.py up` does both taps through WebDriverAgent.
@main
struct ScreenStreamApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 24) {
                Text("ScreenStream").font(.largeTitle.bold())
                Text("Tap the button, then Start Broadcast, to stream this screen on port 8400.")
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                BroadcastPicker()
                    .frame(width: 120, height: 120)
                    .accessibilityIdentifier("broadcastPicker")
            }
        }
    }
}

struct BroadcastPicker: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 120, height: 120))
        picker.showsMicrophoneButton = false
        // Re-signing may rename the extension's bundle ID, so read it from the installed bundle.
        if let plugins = Bundle.main.builtInPlugInsURL,
           let items = try? FileManager.default.contentsOfDirectory(at: plugins, includingPropertiesForKeys: nil),
           let appex = items.first(where: { $0.pathExtension == "appex" })
        {
            picker.preferredExtension = Bundle(url: appex)?.bundleIdentifier
        }
        return picker
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}
