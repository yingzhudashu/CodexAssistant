plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}

// 仅用于源码维护，不进入 APK；复用 Gradle 依赖解析，无需手工安装格式化器。
val ktfmtTool by configurations.creating {
    attributes.attribute(org.gradle.api.attributes.Bundling.BUNDLING_ATTRIBUTE,
        objects.named(org.gradle.api.attributes.Bundling.SHADOWED))
}
dependencies { ktfmtTool("com.facebook:ktfmt:0.64") }
val kotlinSources = fileTree("app/src") { include("**/*.kt") }
fun registerKotlinFormatTask(name: String, checkOnly: Boolean) = tasks.register<JavaExec>(name) {
    group = "verification"
    classpath = ktfmtTool
    mainClass.set("com.facebook.ktfmt.cli.Main")
    args("--kotlinlang-style")
    if (checkOnly) args("--dry-run", "--set-exit-if-changed")
    args(kotlinSources.files.sortedBy { it.path }.map { it.absolutePath })
}
registerKotlinFormatTask("formatKotlin", false)
registerKotlinFormatTask("checkKotlinFormat", true)
