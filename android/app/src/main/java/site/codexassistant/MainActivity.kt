package site.codexassistant

import android.os.Bundle
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import android.content.Intent
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        val credentials = CredentialStore(this)
        // 使用 startForegroundService 兼容 Android O+ 的后台启动限制；服务会在 onCreate
        // 的第一时间调用 startForeground，避免系统将其视为后台普通服务而停止。
        if (credentials.token() != null) ContextCompat.startForegroundService(this, Intent(this, SyncForegroundService::class.java))
        setContent { CodexTheme { CodexScreen(credentials) } }
    }
}
