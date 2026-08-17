package com.termux.paseo;

import static org.junit.Assert.assertEquals;

import java.io.File;

import javax.xml.parsers.DocumentBuilderFactory;

import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

public class PaseoManifestTest {
    private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";
    private static final String TOOLS_NS = "http://schemas.android.com/tools";

    @Test
    public void standaloneManifestDisablesBackupAndLimitsCleartextToLoopback() throws Exception {
        Document manifest = parse(new File("src/main/AndroidManifest.xml"));
        Element application = (Element) manifest.getElementsByTagName("application").item(0);

        assertEquals("false", application.getAttributeNS(ANDROID_NS, "allowBackup"));
        assertEquals("false", application.getAttributeNS(ANDROID_NS, "usesCleartextTraffic"));
        assertEquals("@xml/network_security_config",
            application.getAttributeNS(ANDROID_NS, "networkSecurityConfig"));

        Document networkConfig = parse(new File("src/main/res/xml/network_security_config.xml"));
        Element baseConfig = (Element) networkConfig.getElementsByTagName("base-config").item(0);
        Element domainConfig = (Element) networkConfig.getElementsByTagName("domain-config").item(0);
        Element domain = (Element) networkConfig.getElementsByTagName("domain").item(0);
        assertEquals("false", baseConfig.getAttribute("cleartextTrafficPermitted"));
        assertEquals("true", domainConfig.getAttribute("cleartextTrafficPermitted"));
        assertEquals("127.0.0.1", domain.getTextContent().trim());
    }

    @Test
    public void launcherNameIsPaseoEnhancedInEveryBundledLocale() throws Exception {
        assertEquals("Paseo Enhanced", stringValue(new File("src/main/res/values/strings.xml"), "app_name"));
        assertEquals("Paseo Enhanced", stringValue(new File("src/main/res/values-en/strings.xml"), "app_name"));
        assertEquals("Paseo Enhanced", stringValue(new File("src/main/res/values-zh-rCN/strings.xml"), "app_name"));
    }

    @Test
    public void onlyTheStandaloneLauncherRemainsPublicAmongLegacyEntryPoints() throws Exception {
        Document manifest = parse(new File("src/main/AndroidManifest.xml"));

        assertEquals("true", exported(manifest, "activity", ".paseo.PaseoActivity"));
        assertEquals("false", exported(manifest, "service", ".zerocore.settings.services.TimerExeService"));
        assertEquals("false", exported(manifest, "activity", ".zerocore.settings.TimerActivity"));
        assertEquals("false", exported(manifest, "activity", ".zerocore.guide.TermuxGuideActivity"));
        assertEquals("false", exported(manifest, "activity", ".app.TermuxActivity"));
        assertEquals("false", exported(manifest, "activity-alias", ".HomeActivity"));
        assertEquals("false", exported(manifest, "activity", ".app.activities.SettingsActivity"));
        assertEquals("false", exported(manifest, "service", ".zerocore.ftp.new_ftp.services.FtpService"));
        assertEquals("false", exported(manifest, "provider", ".app.TermuxOpenReceiver$ContentProvider"));
    }

    @Test
    public void usbDocumentProviderUsesTheStandaloneApplicationId() throws Exception {
        Document manifest = parse(new File("src/main/AndroidManifest.xml"));

        assertEquals("${applicationId}.usb.documents", attribute(
            manifest,
            "provider",
            "com.github.mjdev.libaums.storageprovider.UsbDocumentProvider",
            ANDROID_NS,
            "authorities"));
        assertEquals("android:authorities", attribute(
            manifest,
            "provider",
            "com.github.mjdev.libaums.storageprovider.UsbDocumentProvider",
            TOOLS_NS,
            "replace"));
    }

    private static String exported(Document document, String tag, String componentName) {
        return attribute(document, tag, componentName, ANDROID_NS, "exported");
    }

    private static String attribute(
        Document document, String tag, String componentName, String namespace, String attributeName) {
        NodeList nodes = document.getElementsByTagName(tag);
        for (int index = 0; index < nodes.getLength(); index++) {
            Element element = (Element) nodes.item(index);
            if (componentName.equals(element.getAttributeNS(ANDROID_NS, "name"))) {
                return element.getAttributeNS(namespace, attributeName);
            }
        }
        throw new AssertionError("Missing component " + componentName);
    }

    private static String stringValue(File file, String name) throws Exception {
        Document document = parse(file);
        NodeList strings = document.getElementsByTagName("string");
        for (int index = 0; index < strings.getLength(); index++) {
            Element element = (Element) strings.item(index);
            if (name.equals(element.getAttribute("name"))) return element.getTextContent().trim();
        }
        throw new AssertionError("Missing string " + name + " in " + file);
    }

    private static Document parse(File file) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        return factory.newDocumentBuilder().parse(file);
    }
}
