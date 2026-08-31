import org.gradle.api.tasks.wrapper.Wrapper

plugins {
    id("com.android.application") version "9.1.0" apply false
    kotlin("android") version "2.2.10" apply false
    kotlin("plugin.serialization") version "1.9.22" apply false
}

tasks.named<Wrapper>("wrapper") {
    gradleVersion = "8.7"
}
