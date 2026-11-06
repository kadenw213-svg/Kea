package com.kea.scholar;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeaPlugin.class);
        super.onCreate(savedInstanceState);
        // Back closes what's open in Kea (a book, a quiz, a class, a sheet), one step at a time, like any app. Only with
        // nothing left to close does it leave Kea (to the background, so it opens again where it was).
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() == null || getBridge().getWebView() == null) {
                    moveTaskToBack(true);
                    return;
                }
                getBridge().getWebView().evaluateJavascript("(window.keaBack && window.keaBack()) ? 'handled' : 'none'", (r) -> {
                    if (r == null || !r.contains("handled")) moveTaskToBack(true);
                });
            }
        });
    }
}
