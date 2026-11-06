package com.kea.scholar;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;

/**
 * A reply typed into a message notification: sent to the conversation on the class site (Canvas) with the phone's
 * signed-in session, and the notification says whether it went. If it couldn't be sent, tapping it opens the message
 * on the class site with the reply copied, ready to paste.
 */
public class ReplyReceiver extends BroadcastReceiver {
    static final String KEY = "reply";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        Bundle in = RemoteInput.getResultsFromIntent(intent);
        CharSequence typed = in == null ? null : in.getCharSequence(KEY);
        if (typed == null || typed.toString().trim().isEmpty()) return;
        String text = typed.toString().trim();
        String conv = intent.getStringExtra("conv"), url = intent.getStringExtra("url"), head = intent.getStringExtra("head");
        int nid = intent.getIntExtra("nid", 0);
        PendingResult pending = goAsync();
        new Thread(() -> {
            boolean sent = false;
            try {
                Uri base = Uri.parse(Store.home(ctx));
                String post = base.buildUpon().encodedPath("/api/v1/conversations/" + conv + "/add_message").clearQuery().build().toString();
                ClassSite.Answer a = ClassSite.postForm(post, "body=" + java.net.URLEncoder.encode(text, "UTF-8"));
                if (ClassSite.needsSignIn(a) && ClassSite.signInBlocking(ctx, 60)) a = ClassSite.postForm(post, "body=" + java.net.URLEncoder.encode(text, "UTF-8"));
                sent = a.status >= 200 && a.status < 300;
            } catch (Exception ignored) {
            }
            done(ctx, nid, head, text, url, sent);
            pending.finish();
        }).start();
    }

    static void done(Context ctx, int nid, String head, String text, String url, boolean sent) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CheckWorker.channel(ctx, "messages"))
            .setSmallIcon(R.drawable.ic_stat_kea)
            .setColor(0xFF8AB4F8)
            .setContentTitle(sent ? "Reply sent" + (head == null || head.isEmpty() ? "" : " to " + head) : "Kea couldn't send your reply")
            .setContentText(sent ? text : "Tap to open the message. Your reply is copied, ready to paste.")
            .setStyle(new NotificationCompat.BigTextStyle().bigText(sent ? text : "Tap to open the message on the class site. Your reply is copied, ready to paste:\n\n" + text))
            .setSilent(true)
            .setAutoCancel(true);
        if (!sent) {
            android.content.ClipboardManager cm = (android.content.ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(android.content.ClipData.newPlainText("Reply", text));
            if (url != null && !url.isEmpty()) {
                Intent site = new Intent(ctx, SiteActivity.class).putExtra("mode", "open").putExtra("url", url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                b.setContentIntent(PendingIntent.getActivity(ctx, nid + 2, site, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
            }
        }
        try {
            NotificationManagerCompat.from(ctx).notify(nid, b.build());
        } catch (SecurityException ignored) {
        }
    }
}
