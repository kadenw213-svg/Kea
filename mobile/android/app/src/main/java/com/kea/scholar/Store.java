package com.kea.scholar;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;

/**
 * Kea's saved settings on the phone. The class-site login lives in Android's encrypted storage (keys kept by the
 * phone's keystore); everything else (which classes to watch, what was already notified) in plain app storage.
 */
final class Store {
    private Store() {}

    static SharedPreferences secure(Context ctx) {
        try {
            String alias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC);
            return EncryptedSharedPreferences.create(
                "kea_secure",
                alias,
                ctx.getApplicationContext(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
        } catch (Exception e) {
            throw new RuntimeException("Secure storage isn't available on this phone", e);
        }
    }

    static SharedPreferences plain(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences("kea", Context.MODE_PRIVATE);
    }

    static String home(Context ctx) {
        return plain(ctx).getString("home", "");
    }
}
