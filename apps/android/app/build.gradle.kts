plugins {
    id("com.android.application")
    kotlin("android")
    kotlin("plugin.serialization")
}

android {
    namespace = "dev.skaniti.compendium"
    // 36 required by GeckoView 151's transitive androidx deps; targetSdk
    // deliberately stays 34 (no runtime-behavior opt-ins).
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.skaniti.compendium"
        minSdk = 26
        targetSdk = 34
        versionCode = 6
        versionName = "2.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    // GeckoView ships native libs for 4 ABIs (~500 MB fat APK). Per-ABI
    // splits keep installs at real-world size: arm64-v8a = phone,
    // x86_64 = emulator rig. No universal APK.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.13.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.10.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    // Spike (Wave 0b, collector-maturation plan): adb-only GeckoSpikeActivity.
    // Engine-swap commitment is gated on the spike verdict.
    implementation("org.mozilla.geckoview:geckoview:151.0.20260608154138")
    testImplementation("junit:junit:4.13.2")
}
