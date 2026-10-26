package com.kea.scholar;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import androidx.core.app.NotificationCompat;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Reading a book aloud, like an audiobook: Android's own text-to-speech (the voices on the phone work offline), one
 * sentence after another, kept going with the screen off by a media notification with Pause and Stop. The reader gives
 * it the sentences (each with an id saying where it is in the book) and follows along through the listener.
 */
public class ReadAloud extends Service {
    public interface Listener {
        /** `state`: "playing", "paused", "stopped", "done" (reached the end), "error". */
        void onProgress(String id, int index, int total, String state);
    }

    public static class Item {
        final String id;
        final String text;
        /** Silence after it, in milliseconds (a flashcard's time to think). */
        final long pause;

        Item(String id, String text, long pause) {
            this.id = id;
            this.text = text;
            this.pause = pause;
        }
    }

    private static final String CHANNEL = "reading";
    private static final int NOTE = 7;
    private static final String PAUSE = "pause", PLAY = "play", STOP = "stop";

    // (One reading at a time, the reader talks to it directly.)
    static Listener listener;
    private static ReadAloud running;
    /** The running service has stopped itself and is about to be destroyed: a new start waits for that. */
    private static boolean finishing = false;
    private static Context pendingStart = null;
    private static final List<Item> items = new ArrayList<>();
    private static int index = 0;
    private static boolean playing = false;
    private static String title = "Kea";
    private static String voiceName = "";
    private static float rate = 1f;
    private static long sleepAt = 0;
    /** At the end, start again from the first (Listen's "start again at the end"). */
    private static boolean loop = false;

    private TextToSpeech tts;
    private boolean ready = false;
    private PowerManager.WakeLock wake;
    private AudioFocusRequest focus;
    private final Handler main = new Handler(Looper.getMainLooper());

    // ---------- Called by the plugin ----------
    /** Start reading these sentences from the first (replacing anything being read). */
    static void start(Context ctx, List<Item> list, String bookTitle, String voice, float speed, boolean again) {
        loop = again;
        if (running != null) running.cancelGap();
        synchronized (items) {
            items.clear();
            items.addAll(list);
            index = 0;
        }
        title = bookTitle == null || bookTitle.isEmpty() ? "Kea" : bookTitle;
        if (voice != null) voiceName = voice;
        if (speed > 0) rate = speed;
        playing = true;
        if (running != null && finishing) pendingStart = ctx.getApplicationContext();
        else if (running != null) {
            running.applyVoice();
            running.speakCurrent();
        } else launch(ctx);
    }

    private static void launch(Context ctx) {
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(new Intent(ctx, ReadAloud.class));
        else ctx.startService(new Intent(ctx, ReadAloud.class));
    }

    /** More sentences after the ones given (the rest of the chapter, found while the first ones are read). */
    static void append(List<Item> list) {
        synchronized (items) {
            items.addAll(list);
        }
    }

    static void pause() {
        if (running != null) running.doPause();
    }

    static void resume() {
        if (running != null && !playing) {
            playing = true;
            running.speakCurrent();
        }
    }

    static void stopAll() {
        if (running != null) running.finish("stopped");
    }

    /** Back or forward some sentences. */
    static void skip(int by) {
        if (running != null) running.cancelGap();
        synchronized (items) {
            index = Math.max(0, Math.min(items.size() - 1, index + by));
        }
        if (running != null && playing) running.speakCurrent();
        else report(playing ? "playing" : "paused");
    }

    static void settings(String voice, float speed) {
        if (voice != null) voiceName = voice;
        if (speed > 0) rate = speed;
        if (running != null) {
            running.applyVoice();
            if (playing) {
                running.cancelGap();
                running.speakCurrent();
            }
        }
    }

    /** Stop by itself after `minutes` (0: no timer). */
    static void sleepIn(int minutes) {
        sleepAt = minutes > 0 ? System.currentTimeMillis() + minutes * 60_000L : 0;
        if (running != null) running.scheduleSleep();
    }

    static long sleepLeft() {
        return sleepAt == 0 ? 0 : Math.max(0, sleepAt - System.currentTimeMillis());
    }

    static String currentId() {
        synchronized (items) {
            return index < items.size() ? items.get(index).id : "";
        }
    }

    static boolean isPlaying() {
        return playing && running != null;
    }

    private static void report(String state) {
        Listener l = listener;
        if (l == null) return;
        String id;
        int total;
        synchronized (items) {
            id = index < items.size() ? items.get(index).id : "";
            total = items.size();
        }
        l.onProgress(id, index, total, state);
    }

    // ---------- The voices on the phone ----------
    /** The voices for the phone's language (then English), best first: [name, locale, quality, needs internet]. */
    static List<Voice> voices(TextToSpeech t) {
        List<Voice> out = new ArrayList<>();
        if (t == null || t.getVoices() == null) return out;
        String lang = Locale.getDefault().getLanguage();
        for (Voice v : t.getVoices()) {
            if (v.getFeatures() != null && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
            String l = v.getLocale().getLanguage();
            if (l.equals(lang) || l.equals("en")) out.add(v);
        }
        out.sort((a, b) -> {
            boolean ah = a.getLocale().getLanguage().equals(lang), bh = b.getLocale().getLanguage().equals(lang);
            if (ah != bh) return ah ? -1 : 1;
            // (Offline voices first: a book should keep reading with no signal.)
            if (a.isNetworkConnectionRequired() != b.isNetworkConnectionRequired()) return a.isNetworkConnectionRequired() ? 1 : -1;
            if (a.getQuality() != b.getQuality()) return b.getQuality() - a.getQuality();
            return a.getName().compareTo(b.getName());
        });
        return out;
    }

    // ---------- The service ----------
    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        finishing = false;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Reading aloud", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE, note(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTE, note());
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kea:readaloud");
        tts = new TextToSpeech(this, (status) -> main.post(() -> {
            ready = status == TextToSpeech.SUCCESS;
            if (!ready) {
                finish("error");
                return;
            }
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String id) {
                    report("playing");
                }

                @Override
                public void onDone(String id) {
                    main.post(() -> next(id));
                }

                @Override
                public void onError(String id) {
                    main.post(() -> next(id));
                }
            });
            applyVoice();
            if (playing) speakCurrent();
        }));
        scheduleSleep();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? null : intent.getAction();
        if (PAUSE.equals(a)) doPause();
        else if (PLAY.equals(a)) resume();
        else if (STOP.equals(a)) finish("stopped");
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (running == this) running = null;
        finishing = false;
        if (tts != null) tts.shutdown();
        if (wake != null && wake.isHeld()) wake.release();
        dropFocus();
        super.onDestroy();
        // Started again while this one was stopping: begin the new reading now.
        if (pendingStart != null) {
            Context c = pendingStart;
            pendingStart = null;
            launch(c);
        } else playing = false;
    }

    private void applyVoice() {
        if (!ready) return;
        tts.setSpeechRate(rate);
        if (!voiceName.isEmpty())
            for (Voice v : voices(tts))
                if (v.getName().equals(voiceName)) {
                    tts.setVoice(v);
                    break;
                }
    }

    private void speakCurrent() {
        if (!ready) return;
        Item it;
        synchronized (items) {
            if (index >= items.size()) {
                finish("done");
                return;
            }
            it = items.get(index);
        }
        takeFocus();
        if (!wake.isHeld()) wake.acquire(3 * 60 * 60_000L);
        tts.speak(it.text, TextToSpeech.QUEUE_FLUSH, null, it.id + "#" + index);
        update();
        report("playing");
    }

    /** One sentence finished: on to the next (after its pause), unless it was paused, skipped or stopped meanwhile. */
    private void next(String utterance) {
        if (!playing) return;
        long wait;
        synchronized (items) {
            if (!utterance.endsWith("#" + index)) return;
            wait = index < items.size() ? items.get(index).pause : 0;
        }
        Runnable on = () -> {
            if (!playing) return;
            synchronized (items) {
                index++;
                if (index >= items.size() && loop && !items.isEmpty()) index = 0;
            }
            speakCurrent();
        };
        if (wait <= 0) on.run();
        else main.postAtTime(on, GAP, android.os.SystemClock.uptimeMillis() + wait);
    }

    private static final Object GAP = new Object(), SLEEP = new Object();

    private void cancelGap() {
        main.removeCallbacksAndMessages(GAP);
    }

    private void doPause() {
        playing = false;
        cancelGap();
        if (tts != null) tts.stop();
        if (wake != null && wake.isHeld()) wake.release();
        update();
        report("paused");
    }

    private void finish(String state) {
        playing = false;
        finishing = true;
        cancelGap();
        report(state);
        if (tts != null) tts.stop();
        stopForeground(true);
        stopSelf();
    }

    private void scheduleSleep() {
        main.removeCallbacksAndMessages(SLEEP);
        if (sleepAt == 0) return;
        main.postAtTime(() -> {
            sleepAt = 0;
            doPause();
        }, SLEEP, android.os.SystemClock.uptimeMillis() + Math.max(0, sleepAt - System.currentTimeMillis()));
    }

    // (Another app's sound, a call: reading pauses.)
    private final AudioManager.OnAudioFocusChangeListener onFocus = (change) -> {
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) main.post(this::doPause);
    };

    private void takeFocus() {
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            if (focus == null)
                focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setOnAudioFocusChangeListener(onFocus)
                    .build();
            am.requestAudioFocus(focus);
        } else am.requestAudioFocus(onFocus, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
    }

    private void dropFocus() {
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && focus != null) am.abandonAudioFocusRequest(focus);
        else am.abandonAudioFocus(onFocus);
    }

    // ---------- The notification: the book, and Pause or Play, and Stop ----------
    private PendingIntent action(String a, int code) {
        return PendingIntent.getService(this, code, new Intent(this, ReadAloud.class).setAction(a), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification note() {
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        int total, at;
        synchronized (items) {
            total = items.size();
            at = Math.min(index + 1, total);
        }
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_kea)
            .setContentTitle(title)
            .setContentText(playing ? "Reading aloud" : "Paused")
            .setContentIntent(tap)
            .setOngoing(playing)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setProgress(Math.max(1, total), at, false);
        if (playing) b.addAction(0, "Pause", action(PAUSE, 1));
        else b.addAction(0, "Play", action(PLAY, 2));
        b.addAction(0, "Stop", action(STOP, 3));
        return b.build();
    }

    private void update() {
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTE, note());
    }
}
