package org.cimbar.camerafilecopy;
import java.util.Arrays;
import org.junit.Test;
import static org.junit.Assert.*;
public class CameraControlsTest {
    @Test public void zoomUsesOnlySupportedRatiosAndIsBounded() {
        assertEquals(0,CameraControls.nearestZoom(Arrays.asList(100,125,150,200,400,800),.5f));
        assertEquals(2,CameraControls.nearestZoom(Arrays.asList(100,125,150,200),1.6f));
        assertEquals(4,CameraControls.nearestZoom(Arrays.asList(100,125,150,200,400,800),12));
        assertEquals(0,CameraControls.nearestZoom(null,2));
    }
    @Test public void touchFocusMapsBackIntoSensorCoordinates() {
        assertArrayEquals(new float[]{-1000,-1000},CameraControls.sensorPoint(0,0,0),.01f);
        assertArrayEquals(new float[]{-1000,1000},CameraControls.sensorPoint(0,0,90),.01f);
        assertArrayEquals(new float[]{1000,1000},CameraControls.sensorPoint(0,0,180),.01f);
        assertArrayEquals(new float[]{1000,-1000},CameraControls.sensorPoint(0,0,270),.01f);
        for(int rotation:new int[]{0,90,180,270}) assertArrayEquals(new float[]{0,0},CameraControls.sensorPoint(.5f,.5f,rotation),.01f);
    }
}
