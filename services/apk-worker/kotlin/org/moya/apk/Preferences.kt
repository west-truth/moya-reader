package org.moya.apk

import androidx.preference.*
import eu.kanade.tachiyomi.source.ConfigurableSource
import eu.kanade.tachiyomi.source.online.HttpSource
import org.json.JSONArray
import org.json.JSONObject
import eu.kanade.tachiyomi.network.NetworkHelper

/** Original source settings only. No provider names, guessed preference keys, or connection-success claims. */
object Preferences {
    private const val proxyKey = "__moya_outbound_proxy"
    private val secret = Regex("password|secret|token|credential|access.?key|auth.*key|api.?key|접속.?키|인증.?키|비밀번호", RegexOption.IGNORE_CASE)
    private fun screen(source: HttpSource, context: HostContext): List<Preference> {
        if (source !is ConfigurableSource) return emptyList()
        val screen = PreferenceScreen(context)
        screen.sharedPreferences = source.getSourcePreferences()
        source.setupPreferenceScreen(screen)
        return screen.preferences
    }
    private fun kind(field: Preference): String? = when(field) {
        is TwoStatePreference -> "boolean"
        is ListPreference -> "select"
        is EditTextPreference -> "text"
        else -> null
    }
    fun read(sources: Map<String, HttpSource>, context: HostContext): JSONObject {
        val fields = JSONArray()
        fields.put(JSONObject().put("key", proxyKey).put("title", "요청에 사용할 프록시 (선택)")
            .put("kind", "text").put("secret", false).put("value", context.outboundProxy)
            .put("summary", "비워두면 기존 연결을 사용합니다. HTTP·SOCKS5 주소를 입력하세요. 서버 실행 시 주소는 서버 기준이며, 로컬 서버와 운영체제의 VPN 설정은 유지됩니다."))
        val groups = JSONArray()
        for ((id, source) in sources) {
            var unsupported = 0
            try {
                val sourceFields = mutableListOf<JSONObject>()
                val seen = HashSet<String>()
                for (field in screen(source, context)) {
                    val kind = kind(field)
                    if (kind == null || field.key == null || !field.visible) { unsupported++; continue }
                    require(seen.add(field.key) && field.key.length <= 256 && seen.size <= 128)
                    val sensitive = secret.containsMatchIn(field.key + " " + field.title)
                    val value = field.currentValue
                    val row = JSONObject().put("key", JSONArray(listOf(id, field.key)).toString())
                        .put("group", id).put("title", (field.title?.toString() ?: field.key).take(512))
                        .put("kind", kind).put("secret", sensitive).put("disabled", !field.isEnabled)
                    if (sensitive) row.put("configured", value != null && value.toString().isNotEmpty())
                    else {
                        row.put("value", value ?: if (kind == "boolean") false else "")
                        // Dynamic summaries may contain current credentials. The original title is sufficient.
                    }
                    if (field is ListPreference) {
                        val entries = field.entries ?: emptyArray()
                        val values = field.entryValues ?: emptyArray()
                        require(entries.size == values.size && entries.size <= 128)
                        row.put("choices", JSONArray(entries.mapIndexed { i, title -> JSONObject().put("label", title.toString().take(512)).put("value", values[i].toString()) }))
                    }
                    sourceFields.add(row)
                }
                require(fields.length() + sourceFields.size <= 512)
                sourceFields.forEach { fields.put(it) }
                groups.put(JSONObject().put("id", id).put("title", source.name).put("unsupportedActions", unsupported))
            } catch (error: Throwable) {
                if (error is VirtualMachineError) throw error
                // One unsupported source must not prevent configuring other sources in the same factory.
                groups.put(JSONObject().put("id", id).put("title", source.name).put("unavailable", true))
            }
        }
        return JSONObject().put("fields", fields).put("groups", groups)
    }
    fun save(sources: Map<String, HttpSource>, context: HostContext, changes: JSONObject): JSONObject {
        require(changes.length() <= 128)
        val proxy = if (changes.has(proxyKey)) {
            require(changes.get(proxyKey) is String)
            NetworkHelper.validateProxy(changes.getString(proxyKey))
        } else null
        val screens = mutableMapOf<String, List<Preference>>()
        val prepared = changes.keySet().filter { it != proxyKey }.map { key ->
            val pair = JSONArray(key); require(pair.length() == 2)
            val sourceId = pair.getString(0)
            val source = sources[sourceId] ?: error("unknown_source")
            val fields = screens.getOrPut(sourceId) { screen(source, context) }
            val field = fields.single { it.key == pair.getString(1) }
            require(field.isEnabled && field.visible)
            val value = changes.get(key)
            when(kind(field)) {
                "boolean" -> require(value is Boolean)
                "text" -> require(value is String && value.length <= 4096)
                "select" -> require(value is String && (field as ListPreference).entryValues.any { it.toString() == value })
                else -> error("unsupported_preference")
            }
            field to value
        }
        // Validate all shapes before any writes. Source callbacks retain their original validation semantics.
        for ((field, value) in prepared) require(field.callChangeListener(value)) { "preference_rejected" }
        for ((field, value) in prepared) field.saveNewValue(value)
        if (proxy != null) context.setOutboundProxy(proxy)
        return JSONObject().put("saved", true)
    }
}
