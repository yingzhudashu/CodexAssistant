package site.codexassistant

import android.app.Application
/** 应用级同步协调器，确保界面和前台服务共享同一个 WebSocket。 */
class CodexAssistantApplication : Application() {
    lateinit var sync: SyncCoordinator
        private set

    override fun onCreate() {
        super.onCreate()
        sync = SyncCoordinator(this)
    }
}
