package org.moya.apk

import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.SourceFactory
import eu.kanade.tachiyomi.source.model.*
import eu.kanade.tachiyomi.source.online.HttpSource
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.lang.reflect.Proxy
import java.nio.file.Path
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.InjektRegistrar
import uy.kohesive.injekt.api.InjektScope
import suwayomi.tachidesk.manga.impl.util.lang.awaitSingle

/** Private stdio transport. Only the host constructs commands; websites and APKs never address the app API. */
object Main {
    @JvmStatic fun main(args: Array<String>) {
        // Windows console encoding can differ from the UTF-8 JSON transport even on JDK 21.
        val output = PrintStream(java.io.FileOutputStream(java.io.FileDescriptor.out), true, Charsets.UTF_8)
        // Extension logging must never corrupt RPC frames.
        System.setOut(PrintStream(System.err, true, Charsets.UTF_8))
        val context = HostContext(Path.of(args[1]), args[2])
        val network = NetworkHelper { context.outboundProxy }
        val json = Json { ignoreUnknownKeys = true; isLenient = true }
        val registrar = Proxy.newProxyInstance(Main::class.java.classLoader, arrayOf(InjektRegistrar::class.java)) { _, method, params ->
            if (method.name == "hasFactory") true else when (params[0].toString()) {
                "class eu.kanade.tachiyomi.network.NetworkHelper" -> network
                "class kotlinx.serialization.json.Json" -> json
                "class android.app.Application", "class android.content.Context" -> context
                else -> error("unbound_android_dependency")
            }
        } as InjektRegistrar
        Injekt = InjektScope(registrar)
        val instance = Class.forName(args[0]).getConstructor().newInstance()
        val loaded = when (instance) { is SourceFactory -> instance.createSources(); is Source -> listOf(instance); else -> error("unsupported_source_api") }
        require(loaded.isNotEmpty() && loaded.size <= 1000 && loaded.map { it.id }.distinct().size == loaded.size) { "invalid_source_factory" }
        val sources = loaded.filterIsInstance<HttpSource>().associateBy { it.id.toString() }
        val input = BufferedInputStream(System.`in`)
        while (true) {
            val line = ByteArrayOutputStream()
            var next = input.read()
            if (next == -1) break
            while (next != -1 && next != 10) {
                require(line.size() < 1024 * 1024) { "request_limit" }
                line.write(next); next = input.read()
            }
            var id: Any = JSONObject.NULL
            val response = try {
                val request = JSONObject(line.toString(Charsets.UTF_8))
                id = request.get("id")
                val params = request.optJSONObject("params") ?: JSONObject()
                // Page discovery may include an original extension's external authentication job.
                // Ordinary catalog/image HTTP deadlines stay short; cancellation still kills the worker.
                val result = runBlocking { withTimeout(if (request.getString("method") == "pages") 150_000 else 30_000) {
                    when (request.getString("method")) {
                        "preferences" -> Preferences.read(sources, context)
                        "preferences-save" -> context.transaction { Preferences.save(sources, context, params.getJSONObject("values")) }
                        else -> invoke(sources, request.getString("method"), params)
                    }
                } }
                JSONObject().put("id", id).put("result", result)
            } catch (error: Throwable) {
                if (error is VirtualMachineError) throw error
                if (java.lang.Boolean.getBoolean("moya.apk.debug")) error.printStackTrace(System.err)
                val code = when (error) {
                    is kotlinx.coroutines.TimeoutCancellationException, is java.net.SocketTimeoutException -> "apk_request_timeout"
                    is LinkageError, is UnsupportedOperationException -> "apk_android_feature_unsupported"
                    else -> if (generateSequence(error as Throwable?) { it.cause }.any {
                        it is LinkageError || it is UnsupportedOperationException ||
                        (it is RuntimeException && it.message == "Stub!")
                    }) "apk_android_feature_unsupported" else "apk_request_failed"
                }
                JSONObject().put("id", id).put("error", code)
            }
            output.println(response.toString()); output.flush()
        }
    }
    private fun work(manga: SManga) = JSONObject().put("url", manga.url).put("title", manga.title)
        .put("author", manga.author).put("artist", manga.artist).put("description", manga.description)
        .put("genre", manga.genre).put("status", manga.status).put("cover", manga.thumbnail_url)
    private suspend fun invoke(sources: Map<String, HttpSource>, method: String, input: JSONObject): Any {
        if (method == "describe") return JSONArray(sources.values.map { JSONObject().put("id", it.id.toString()).put("name", it.name)
            .put("lang", it.lang) })
        val source = sources[input.getString("sourceId")] ?: error("unknown_source")
        val manga = SManga.create().apply { url = input.optString("workUrl"); title = input.optString("title", "Work") }
        return when (method) {
            "list" -> {
                val page = input.optInt("page", 1); require(page in 1..100000)
                val filters = source.getFilterList()
                val changes = input.optJSONArray("filters") ?: JSONArray()
                val definitions = sourceFilters(filters, changes)
                val mode = if (input.optString("query").isNotEmpty()) "search" else input.optString("mode", if (changes.length() > 0) "search" else "popular")
                val result = when (mode) {
                    "popular" -> source.getPopularManga(page)
                    "latest" -> source.getLatestUpdates(page)
                    else -> source.getSearchManga(page, input.optString("query"), filters)
                }
                require(result.mangas.size <= 5000)
                JSONObject().put("items", JSONArray(result.mangas.map(::work))).put("hasNextPage", result.hasNextPage)
                    .put("browse", JSONObject().put("activeMode", mode)
                        .put("availableModes", JSONArray(if (source.supportsLatest) listOf("popular", "latest", "search") else listOf("popular", "search")))
                        .put("filters", definitions))
            }
            "detail" -> work(source.fetchMangaDetails(manga).awaitSingle())
            "chapters" -> {
                val result = source.fetchChapterList(manga).awaitSingle(); require(result.size <= 100000)
                JSONArray(result.map { JSONObject().put("url", it.url).put("title", it.name).put("number", it.chapter_number.toDouble())
                    .put("scanlator", it.scanlator).put("uploadedAt", it.date_upload) })
            }
            "pages" -> {
                val chapter = SChapter.create().apply { url = input.getString("chapterUrl"); name = input.optString("title", "Chapter") }
                val result = source.getPageList(chapter); require(result.isNotEmpty() && result.size <= 2048)
                JSONArray(result.map { JSONObject().put("index", it.index).put("url", it.url).put("imageUrl", it.imageUrl) })
            }
            "image", "cover" -> {
                val response = if (method == "cover") source.client.newCall(Request.Builder().url(input.getString("url")).headers(source.headers).build()).execute()
                    else {
                        val page = Page(input.getInt("index"), input.optString("url"), input.optString("imageUrl").ifEmpty { null })
                        if (page.imageUrl == null) page.imageUrl = source.getImageUrl(page)
                        source.getImage(page)
                    }
                response.use {
                    require(it.isSuccessful)
                    val bytes = it.body.byteStream().readNBytes(20 * 1024 * 1024 + 1)
                    require(bytes.isNotEmpty() && bytes.size <= 20 * 1024 * 1024)
                    val mime = when {
                        bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() && bytes[2] == 0xff.toByte() -> "image/jpeg"
                        bytes.size >= 8 && bytes.take(8) == listOf(137,80,78,71,13,10,26,10).map { n -> n.toByte() } -> "image/png"
                        bytes.size >= 6 && String(bytes, 0, 6, Charsets.US_ASCII) in listOf("GIF87a", "GIF89a") -> "image/gif"
                        bytes.size >= 12 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" && String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP" -> "image/webp"
                        else -> error("unsupported_image")
                    }
                    JSONObject().put("contentType", mime).put("base64", Base64.getEncoder().encodeToString(bytes))
                }
            }
            else -> error("unsupported_method")
        }
    }
}
