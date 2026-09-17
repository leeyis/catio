package org.cimbar.camerafilecopy;

import org.opencv.android.OpenCVLoader;

final class NativeReceiver {
    private static boolean loaded;
    static synchronized boolean initialize() {
        if (loaded) return true;
        if (!OpenCVLoader.initLocal()) return false;
        try { System.loadLibrary("cfc-cpp"); loaded = true; return true; }
        catch (UnsatisfiedLinkError e) { return false; }
    }
    static native void submit(long matrix, String directory, int mode);
    static native double[] snapshot();
    static native byte[] pollFile();
    static native void reset();
    private NativeReceiver() {}
}
