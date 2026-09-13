package org.moya.apk;

import com.android.apksig.ApkVerifier;
import java.io.File;
import java.io.StringReader;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.TreeSet;
import javax.xml.parsers.DocumentBuilderFactory;
import net.dongliu.apk.parser.ApkFile;
import org.json.JSONArray;
import org.json.JSONObject;
import org.xml.sax.InputSource;

/** Parses and verifies signatures without loading or executing any APK class. */
public final class Inspect {
    public static void main(String[] args) throws Exception {
        File file = new File(args[0]);
        if (!file.isFile() || file.length() > 32 * 1024 * 1024) throw new IllegalArgumentException("apk_size_limit");
        var verified = new ApkVerifier.Builder(file).setMinCheckedPlatformVersion(21).build().verify();
        if (!verified.isVerified() || verified.getSignerCertificates().isEmpty()) throw new IllegalArgumentException("apk_signature_invalid");
        TreeSet<String> certificates = new TreeSet<>();
        for (var certificate : verified.getSignerCertificates())
            certificates.add(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded())));
        try (var apk = new ApkFile(file)) {
            String xml = apk.getManifestXml();
            if (xml.length() > 512 * 1024) throw new IllegalArgumentException("apk_manifest_limit");
            var factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true); factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            var document = factory.newDocumentBuilder().parse(new InputSource(new StringReader(xml)));
            String ns = "http://schemas.android.com/apk/res/android";
            var manifest = document.getDocumentElement();
            String pkg = manifest.getAttribute("package");
            if (!pkg.matches("[A-Za-z][\\w]*(\\.[A-Za-z][\\w]*)+")) throw new IllegalArgumentException("apk_manifest_invalid");
            boolean manga = false;
            var features = document.getElementsByTagName("uses-feature");
            for (int i = 0; i < features.getLength(); i++) {
                var item = (org.w3c.dom.Element) features.item(i);
                if (item.getAttributeNS(ns, "name").equals("tachiyomi.extension")) manga = true;
            }
            if (!manga) throw new IllegalArgumentException("apk_manga_api_required");
            String entry = "";
            var metadata = document.getElementsByTagName("meta-data");
            for (int i = 0; i < metadata.getLength(); i++) {
                var item = (org.w3c.dom.Element) metadata.item(i);
                if (item.getAttributeNS(ns, "name").equals("tachiyomi.extension.class")) {
                    if (!entry.isEmpty()) throw new IllegalArgumentException("apk_manifest_invalid");
                    entry = item.getAttributeNS(ns, "value");
                }
            }
            if (entry.startsWith(".")) entry = pkg + entry;
            else if (!entry.contains(".")) entry = pkg + "." + entry;
            if (!entry.startsWith(pkg + ".") || !entry.matches("[A-Za-z_$][A-Za-z0-9_$.]+"))
                throw new IllegalArgumentException("apk_entry_invalid");
            long code = Long.parseLong(manifest.getAttributeNS(ns, "versionCode"));
            if (code < 1 || code > Integer.MAX_VALUE) throw new IllegalArgumentException("apk_version_invalid");
            System.out.println(new JSONObject().put("pkg", pkg).put("entry", entry).put("code", code)
                .put("version", manifest.getAttributeNS(ns, "versionName")).put("signers", new JSONArray(certificates)));
        }
    }
}
