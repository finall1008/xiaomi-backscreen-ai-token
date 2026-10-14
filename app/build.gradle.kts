import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
android {
    namespace = "dev.finall.aitoken"
    compileSdk = 37
    defaultConfig {
        applicationId = "dev.finall.aitoken"
        minSdk = 35
        targetSdk = 35
        versionCode = 2
        versionName = "0.1.1"
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_21; targetCompatibility = JavaVersion.VERSION_21 }
    // Always use the owner's key for both variants; never fall back to a debug key.
    val finallKeystore = rootProject.file("signing/finall.jks")
    check(finallKeystore.isFile) { "Missing signing/finall.jks; refusing to use a different key." }
    val isCi = providers.environmentVariable("CI").map(String::toBoolean).getOrElse(false)
    val finall = signingConfigs.create("finall") {
        storeFile = finallKeystore
        if (isCi) {
            fun ciProperty(name: String): String =
                requireNotNull(providers.environmentVariable(name).orNull?.takeIf { it.isNotBlank() }) {
                    "Missing $name for CI signing; refusing to use a different key."
                }
            keyAlias = ciProperty("RELEASE_KEY_ALIAS")
            check(keyAlias == "finall") { "CI must use the existing finall signing alias." }
            storePassword = ciProperty("RELEASE_STORE_PASSWORD")
            keyPassword = ciProperty("RELEASE_KEY_PASSWORD")
        } else {
            val signingProperties = Properties().apply {
                rootProject.file("signing/signing.properties").inputStream().use { load(it) }
            }
            val keychainService = signingProperties.getProperty("keychainService")
            val keychainAccount = signingProperties.getProperty("keychainAccount")
            check(!keychainService.isNullOrBlank() && !keychainAccount.isNullOrBlank()) {
                "Configure keychainService and keychainAccount in signing/signing.properties."
            }
            val keychain = providers.exec {
                commandLine("/usr/bin/security", "find-generic-password",
                    "-s", keychainService, "-a", keychainAccount, "-w")
                isIgnoreExitValue = true
            }
            check(keychain.result.get().exitValue == 0) {
                "Cannot read finall signing password from macOS Keychain; refusing to use a different key."
            }
            val password = keychain.standardOutput.asText.get().trimEnd('\r', '\n')
            check(password.isNotEmpty()) { "The finall signing password is empty." }
            storePassword = password
            keyAlias = "finall"
            keyPassword = password
        }
    }
    buildTypes {
        debug { signingConfig = finall }
        release { signingConfig = finall; isMinifyEnabled = false }
    }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21) } }
dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.12.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.work:work-runtime-ktx:2.11.1")
    implementation("androidx.webkit:webkit:1.15.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("top.yukonga.miuix.kmp:miuix-ui-android:0.9.4")
    implementation("top.yukonga.miuix.kmp:miuix-icons:0.9.4")
    implementation("top.yukonga.miuix.kmp:miuix-nav:0.9.4")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
