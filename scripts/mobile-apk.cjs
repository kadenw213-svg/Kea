// Builds Kea for Android (an installable APK) from mobile/, using the Java and Android SDK Kea's setup put in
// %LOCALAPPDATA%\KeaBuild. The APK lands in %LOCALAPPDATA%\KeaBuild\Kea.apk (outside OneDrive).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const kb = path.join(process.env.LOCALAPPDATA, 'KeaBuild');
const env = { ...process.env, JAVA_HOME: path.join(kb, 'jdk'), ANDROID_HOME: path.join(kb, 'android-sdk'), ANDROID_SDK_ROOT: path.join(kb, 'android-sdk') };
// Windows names it "Path": add Java in front under whatever name it already has.
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
env[pathKey] = `${path.join(env.JAVA_HOME, 'bin')};${env[pathKey]}`;
const mobile = path.join(__dirname, '..', 'mobile');
const run = (cmd, cwd) => execSync(cmd, { stdio: 'inherit', cwd, env });

fs.writeFileSync(path.join(mobile, 'android', 'local.properties'), `sdk.dir=${env.ANDROID_HOME.replace(/\\/g, '\\\\')}\n`);
run('npx vite build', mobile);
run('npx cap sync android', mobile);
run('.\\gradlew.bat assembleDebug --no-daemon -q', path.join(mobile, 'android'));
const apk = path.join(kb, 'mobile-build', 'app', 'outputs', 'apk', 'debug', 'app-debug.apk');
fs.copyFileSync(apk, path.join(kb, 'Kea.apk'));
console.log(`\nBuilt ${path.join(kb, 'Kea.apk')} (${(fs.statSync(apk).size / 1048576).toFixed(1)} MB)\n`);
