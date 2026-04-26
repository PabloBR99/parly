# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# react-native-tts — JNI bindings via @ReactMethod, keep package
-keep class net.no_mad.tts.** { *; }
-keepclassmembers class net.no_mad.tts.** { *; }

# react-native-audio-record — JNI bindings, keep package
-keep class com.goodatlas.audiorecord.** { *; }
-keepclassmembers class com.goodatlas.audiorecord.** { *; }
