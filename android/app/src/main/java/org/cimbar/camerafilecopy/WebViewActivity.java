package org.cimbar.camerafilecopy;

import android.annotation.SuppressLint;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.*;
import android.widget.*;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;
import java.io.*;
import static org.cimbar.camerafilecopy.ReceiverUi.*;

/** Catio sender with automatic defaults and a persistent three-tab shell. */
public class WebViewActivity extends ComponentActivity {
    private WebView webView;
    private ValueCallback<Uri[]> uploadMessage;
    private static final int CHOOSE_FILE=222;
    private FrameLayout root;
    private LinearLayout page;
    private View fullView;
    private WebChromeClient.CustomViewCallback fullCallback;
    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state); WindowCompat.setDecorFitsSystemWindows(getWindow(),false);
        getOnBackPressedDispatcher().addCallback(this,new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { if(fullView!=null) leaveFullscreen(); else finish(); }
        });
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root=new FrameLayout(this); root.setBackgroundColor(color(this,R.color.canvas));
        ViewCompat.setOnApplyWindowInsetsListener(root,(v,insets)->{
            Insets bars=insets.getInsets(WindowInsetsCompat.Type.systemBars()|WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left,bars.top,bars.right,bars.bottom); return insets;
        });
        page=column(this); root.addView(page,new FrameLayout.LayoutParams(-1,-1));
        LinearLayout header=row(this); header.setPadding(dp(this,20),dp(this,12),dp(this,20),dp(this,12));
        ImageView logo=new ImageView(this); logo.setImageResource(R.drawable.ic_catio); header.addView(logo,new LinearLayout.LayoutParams(dp(this,40),dp(this,40)));
        LinearLayout titles=column(this); titles.setPadding(dp(this,12),0,0,0); titles.addView(text(this,"Catio",21,R.color.text_primary,true)); titles.addView(text(this,getString(R.string.tagline),11,R.color.text_secondary,false)); header.addView(titles,weight());
        TextView offline=text(this,getString(R.string.offline),11,R.color.success,true); offline.setPadding(dp(this,10),dp(this,6),dp(this,10),dp(this,6)); offline.setBackground(surface(this,R.color.surface,20)); header.addView(offline); page.addView(header);
        webView=new WebView(this); webView.setId(R.id.sender_webview); page.addView(webView,new LinearLayout.LayoutParams(-1,0,1));
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(true); // Explicitly chosen Storage Access Framework files.
        webView.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        WebViewAssetLoader loader=new WebViewAssetLoader.Builder().addPathHandler("/assets/",new WebViewAssetLoader.AssetsPathHandler(this)).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request) {
                WebResourceResponse local=loader.shouldInterceptRequest(request.getUrl());
                return local!=null?local:new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request) {
                Uri url=request.getUrl();
                if("https".equals(url.getScheme()) && "appassets.androidplatform.net".equals(url.getHost())) return false;
                if(request.hasGesture() && request.isForMainFrame() && ("https".equals(url.getScheme()) || "http".equals(url.getScheme()))) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW,url)); } catch(ActivityNotFoundException ignored) { }
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            // Upstream console messages contain filenames. Keep them out of device logs.
            @Override public boolean onConsoleMessage(ConsoleMessage message) { return true; }
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params) {
                if(uploadMessage!=null) uploadMessage.onReceiveValue(null); uploadMessage=callback;
                try { startActivityForResult(params.createIntent(),CHOOSE_FILE); return true; }
                catch(ActivityNotFoundException e) { uploadMessage=null; return false; }
            }
            @Override public void onShowCustomView(View view,CustomViewCallback callback) {
                if(fullView!=null) { callback.onCustomViewHidden(); return; }
                fullView=view; fullCallback=callback; page.setVisibility(View.GONE); root.addView(view,new FrameLayout.LayoutParams(-1,-1));
            }
            @Override public void onHideCustomView() { leaveFullscreen(); }
        });
        page.addView(navigation(this,1,tab->{
            if(tab==1)return;
            startActivity(new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("tab",tab)); finish();
        }));
        setContentView(root); applySystemBars(this,root); webView.setBackgroundColor(color(this,R.color.canvas)); webView.loadUrl("https://appassets.androidplatform.net/assets/sender.html?lang="+getResources().getConfiguration().locale.getLanguage());
    }
    private void leaveFullscreen() {
        if(fullView==null) return; root.removeView(fullView); fullView=null; page.setVisibility(View.VISIBLE);
        if(fullCallback!=null) { fullCallback.onCustomViewHidden(); fullCallback=null; }
    }
    @Override protected void onActivityResult(int requestCode,int resultCode,Intent data) {
        super.onActivityResult(requestCode,resultCode,data);
        if(requestCode==CHOOSE_FILE && uploadMessage!=null) { uploadMessage.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode,data)); uploadMessage=null; }
    }
    @Override protected void onPause() { webView.evaluateJavascript("window.Wormhole && Wormhole.pause()",null); webView.onPause(); webView.pauseTimers(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if(webView!=null) { webView.resumeTimers(); webView.onResume(); webView.evaluateJavascript("window.Wormhole && Wormhole.resume()",null); } }
    @Override protected void onDestroy() {
        if(uploadMessage!=null) { uploadMessage.onReceiveValue(null); uploadMessage=null; }
        leaveFullscreen(); webView.stopLoading(); page.removeView(webView); webView.destroy(); super.onDestroy();
    }

}
