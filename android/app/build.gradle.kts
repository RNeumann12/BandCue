import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Load the release signing credentials from android/keystore.properties when it
// exists. The file and the keystore itself are gitignored so secrets stay local;
// without them the release build falls back to debug signing so CI/clones still
// build (just not with the distributable key).
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) {
        keystorePropsFile.inputStream().use { load(it) }
    }
}
val hasReleaseSigning = keystoreProps.getProperty("storeFile")?.let {
    rootProject.file(it).exists()
} ?: false

android {
    namespace = "com.bandcue.songsterr"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.bandcue.songsterr"
        minSdk = 26
        targetSdk = 35
        versionCode = 10
        versionName = "1.1.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}
