package site.codexassistant

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
                    PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        val credentials = CredentialStore(this)
        setContent { CodexTheme { CodexScreen(credentials) } }
    }

    override fun onStart() {
        super.onStart()
        val sync = (application as CodexAssistantApplication).sync
        sync.foreground()
        sync.ensureForegroundService()
    }

    override fun onStop() {
        (application as CodexAssistantApplication).sync.background(isChangingConfigurations)
        super.onStop()
    }
}
