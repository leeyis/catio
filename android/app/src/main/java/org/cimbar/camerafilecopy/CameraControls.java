package org.cimbar.camerafilecopy;

import java.util.List;

/** Camera math kept independent of the device for orientation/zoom regression tests. */
final class CameraControls {
    static int nearestZoom(List<Integer> ratios, float requested) {
        if (ratios == null || ratios.isEmpty()) return 0;
        float wanted = Math.max(1f, Math.min(4f, requested)) * 100;
        int best = 0;
        for (int i = 1; i < ratios.size(); i++)
            if (ratios.get(i) <= 400 && Math.abs(ratios.get(i) - wanted) < Math.abs(ratios.get(best) - wanted)) best = i;
        return best;
    }
    static float[] sensorPoint(float x, float y, int rotation) {
        float sx=x, sy=y;
        if (rotation==90) { sx=y; sy=1-x; }
        else if (rotation==180) { sx=1-x; sy=1-y; }
        else if (rotation==270) { sx=1-y; sy=x; }
        return new float[]{Math.max(-1000,Math.min(1000,sx*2000-1000)), Math.max(-1000,Math.min(1000,sy*2000-1000))};
    }
    private CameraControls() { }
}
