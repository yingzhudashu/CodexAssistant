plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val releaseStore = providers.environmentVariable("CODEX_ASSISTANT_KEYSTORE").orNull
val releaseStorePassword = providers.environmentVariable("CODEX_ASSISTANT_KEYSTORE_PASSWORD").orNull
val releaseKeyAlias = providers.environmentVariable("CODEX_ASSISTANT_KEY_ALIAS").orNull
val releaseKeyPassword = providers.environmentVariable("CODEX_ASSISTANT_KEY_PASSWORD").orNull

android {
    namespace = "site.codexassistant"
    compileSdk = 35
    defaultConfig {
        applicationId = "site.codexassistant"; minSdk = 26; targetSdk = 35; versionCode = 20; versionName = "2.0.17"
    }
    signingConfigs {
        create("release") {
            if (releaseStore != null && releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null) {
                storeFile = file(releaseStore)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                this.keyPassword = releaseKeyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") { buildConfigField("String", "CODEX_BASE_URL", "\"http://127.0.0.1:3240\""); manifestPlaceholders["usesCleartextTraffic"] = true }
        getByName("release") {
            isMinifyEnabled = true
            // 正式版首次启动由用户填写地址，不将私人服务器编入安装包。
            buildConfigField("String", "CODEX_BASE_URL", "\"\"")
            manifestPlaceholders["usesCleartextTraffic"] = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}

tasks.matching { it.name == "packageRelease" }.configureEach {
    doFirst {
        check(releaseStore != null && releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null) {
            "Production APK signing credentials are required."
        }
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.junit4)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
}
