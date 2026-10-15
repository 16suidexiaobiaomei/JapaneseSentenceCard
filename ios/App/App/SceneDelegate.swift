import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // Window and root view controller come from Main.storyboard via
        // UISceneStoryboardFile in Info.plist — nothing to set up manually here.
    }

    // Custom URL scheme opens — the scene-lifecycle equivalent of
    // AppDelegate's old application(_:open:options:).
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let context = URLContexts.first else { return }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: [:])
    }

    // Universal Links (the /tag/<id> community-tag deep link) — the
    // scene-lifecycle equivalent of AppDelegate's old
    // application(_:continue:restorationHandler:).
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }

}
