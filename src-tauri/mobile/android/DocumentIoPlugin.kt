package com.local.noveldeskreader.plugins

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.io.InterruptedIOException
import java.io.OutputStream
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

private const val MAX_DOCUMENT_CHUNK_BYTES = 256 * 1024
private const val DOCUMENT_CACHE_DIRECTORY = "noveldesk-document-io"
private const val LIBRARY_FOLDER_PREFERENCES = "noveldesk-library-folders"

@InvokeArg
class PickDocumentsArgs {
  var multiple: Boolean = false
  var mimeTypes: List<String> = emptyList()
  var extensions: List<String> = emptyList()
}

@InvokeArg
class BeginSaveDocumentArgs {
  lateinit var suggestedName: String
  lateinit var mimeType: String
}

@InvokeArg
class DocumentTokenArgs {
  lateinit var token: String
}

@InvokeArg
class ReadDocumentChunkArgs {
  lateinit var token: String
  var offset: Long = 0
  var maxBytes: Int = 0
}

@InvokeArg
class WriteDocumentChunkArgs {
  lateinit var token: String
  lateinit var dataBase64: String
}

@InvokeArg
class ScanFolderArgs {
  lateinit var folderId: String
  var recursive: Boolean = true
  var maxEntries: Int = 20000
}

@InvokeArg
class OpenFolderFileArgs {
  lateinit var folderId: String
  lateinit var documentId: String
}

@InvokeArg
class FolderIdArgs {
  lateinit var folderId: String
}

private data class SaveSession(
  val uri: Uri,
  val output: OutputStream,
  var bytesWritten: Long = 0,
)

@TauriPlugin
class DocumentIoPlugin(private val activity: Activity) : Plugin(activity) {
  private val pickerActive = AtomicBoolean(false)
  private val destroyed = AtomicBoolean(false)
  private val ioExecutor = Executors.newSingleThreadExecutor()
  private val openDocuments = ConcurrentHashMap<String, File>()
  private val saveSessions = ConcurrentHashMap<String, SaveSession>()
  private val folderPreferences by lazy {
    activity.getSharedPreferences(LIBRARY_FOLDER_PREFERENCES, Activity.MODE_PRIVATE)
  }
  private val cacheDirectory by lazy {
    File(activity.cacheDir, DOCUMENT_CACHE_DIRECTORY).apply { mkdirs() }
  }

  init {
    File(activity.cacheDir, DOCUMENT_CACHE_DIRECTORY).listFiles()?.forEach { stale ->
      if (System.currentTimeMillis() - stale.lastModified() > 24 * 60 * 60 * 1_000L) stale.delete()
    }
  }

  @Command
  fun pickDocuments(invoke: Invoke) {
    if (!pickerActive.compareAndSet(false, true)) {
      invoke.reject("another Android document picker is already open")
      return
    }
    try {
      val args = invoke.parseArgs(PickDocumentsArgs::class.java)
      val mimeTypes = args.mimeTypes.mapNotNull(::validMimeType).distinct().ifEmpty {
        listOf("text/plain", "application/epub+zip", "application/pdf", "application/zip", "application/octet-stream")
      }
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = if (mimeTypes.size == 1) mimeTypes.first() else "*/*"
        putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.multiple)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      startActivityForResult(invoke, intent, "pickDocumentsResult")
    } catch (error: Exception) {
      pickerActive.set(false)
      invoke.reject("Android document picker could not be opened", error)
    }
  }

  @ActivityCallback
  fun pickDocumentsResult(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode != Activity.RESULT_OK) {
      pickerActive.set(false)
      invoke.resolveObject(mapOf("cancelled" to true, "documents" to emptyList<Any>()))
      return
    }

    try {
      val uris = linkedSetOf<Uri>()
      result.data?.clipData?.let { clips ->
        for (index in 0 until clips.itemCount) uris.add(clips.getItemAt(index).uri)
      }
      result.data?.data?.let(uris::add)
      if (uris.isEmpty()) throw IllegalArgumentException("Android document picker returned no readable document")

      ioExecutor.execute {
        val copied = mutableListOf<Pair<String, File>>()
        try {
          val documents = uris.map { uri ->
            val metadata = queryMetadata(uri)
            val token = UUID.randomUUID().toString()
            val cached = File(cacheDirectory, "$token.bin")
            copied.add(token to cached)
            activity.contentResolver.openInputStream(uri).use { input ->
              if (input == null) throw IllegalArgumentException("selected Android document cannot be opened")
              cached.outputStream().use { output ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                  if (Thread.currentThread().isInterrupted) throw InterruptedIOException("document copy was interrupted")
                  val read = input.read(buffer)
                  if (read < 0) break
                  output.write(buffer, 0, read)
                }
              }
            }
            openDocuments[token] = cached
            mapOf(
              "token" to token,
              "fileName" to safeDocumentName(metadata.fileName),
              "mimeType" to (metadata.mimeType ?: mimeTypeForName(metadata.fileName)),
              "byteLength" to cached.length(),
              "lastModified" to metadata.lastModified,
            )
          }
          completeOnUiThread {
            pickerActive.set(false)
            invoke.resolveObject(mapOf("cancelled" to false, "documents" to documents))
          }
        } catch (error: Exception) {
          copied.forEach { (token, file) ->
            openDocuments.remove(token)
            file.delete()
          }
          completeOnUiThread {
            pickerActive.set(false)
            invoke.reject("selected Android document could not be prepared", error)
          }
        }
      }
    } catch (error: Exception) {
      pickerActive.set(false)
      invoke.reject("selected Android document could not be prepared", error)
    }
  }

  @Command
  fun pickFolder(invoke: Invoke) {
    if (!pickerActive.compareAndSet(false, true)) {
      invoke.reject("another Android document picker is already open")
      return
    }
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
      }
      startActivityForResult(invoke, intent, "pickFolderResult")
    } catch (error: Exception) {
      pickerActive.set(false)
      invoke.reject("Android folder picker could not be opened", error)
    }
  }

  @ActivityCallback
  fun pickFolderResult(invoke: Invoke, result: ActivityResult) {
    pickerActive.set(false)
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      invoke.resolveObject(mapOf("cancelled" to true))
      return
    }
    try {
      activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      val folderId = UUID.randomUUID().toString()
      folderPreferences.edit().putString(folderId, uri.toString()).apply()
      invoke.resolveObject(
        mapOf(
          "cancelled" to false,
          "folderId" to folderId,
          "displayName" to queryTreeDisplayName(uri),
        ),
      )
    } catch (error: Exception) {
      invoke.reject("selected Android folder could not be retained", error)
    }
  }

  @Command
  fun scanFolder(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ScanFolderArgs::class.java)
      val treeUri = folderUri(args.folderId)
      val maxEntries = args.maxEntries.coerceIn(1, 20000)
      ioExecutor.execute {
        try {
          val entries = mutableListOf<Map<String, Any?>>()
          val rootDocumentId = DocumentsContract.getTreeDocumentId(treeUri)
          scanDocumentChildren(treeUri, rootDocumentId, "", args.recursive, maxEntries, entries)
          completeOnUiThread { invoke.resolveObject(mapOf("entries" to entries)) }
        } catch (error: Exception) {
          completeOnUiThread { invoke.reject("Android folder could not be scanned", error) }
        }
      }
    } catch (error: Exception) {
      invoke.reject("Android folder scan request is invalid", error)
    }
  }

  @Command
  fun openFolderFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(OpenFolderFileArgs::class.java)
      val treeUri = folderUri(args.folderId)
      val documentId = validDocumentId(args.documentId)
      val documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId)
      ioExecutor.execute {
        var token: String? = null
        var cached: File? = null
        try {
          val metadata = queryMetadata(documentUri)
          val documentToken = UUID.randomUUID().toString()
          val cacheFile = File(cacheDirectory, "$documentToken.bin")
          token = documentToken
          cached = cacheFile
          activity.contentResolver.openInputStream(documentUri).use { input ->
            if (input == null) throw IllegalArgumentException("selected folder file cannot be opened")
            cacheFile.outputStream().use { output -> input.copyTo(output) }
          }
          openDocuments[documentToken] = cacheFile
          val document = mapOf(
            "token" to documentToken,
            "fileName" to safeDocumentName(metadata.fileName),
            "mimeType" to (metadata.mimeType ?: mimeTypeForName(metadata.fileName)),
            "byteLength" to cacheFile.length(),
            "lastModified" to metadata.lastModified,
          )
          completeOnUiThread { invoke.resolveObject(mapOf("document" to document)) }
        } catch (error: Exception) {
          token?.let(openDocuments::remove)
          cached?.delete()
          completeOnUiThread { invoke.reject("Android folder file could not be prepared", error) }
        }
      }
    } catch (error: Exception) {
      invoke.reject("Android folder file request is invalid", error)
    }
  }

  @Command
  fun forgetFolder(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(FolderIdArgs::class.java)
      val folderId = validFolderId(args.folderId)
      val uri = folderPreferences.getString(folderId, null)?.let(Uri::parse)
      if (uri != null) {
        runCatching {
          activity.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
      }
      folderPreferences.edit().remove(folderId).apply()
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("Android folder permission could not be removed", error)
    }
  }

  @Command
  fun readChunk(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ReadDocumentChunkArgs::class.java)
      val file = openDocuments[validToken(args.token)] ?: throw IllegalArgumentException("document token has expired")
      if (args.offset < 0 || args.offset > file.length()) throw IllegalArgumentException("document offset is invalid")
      val maxBytes = args.maxBytes.coerceIn(1, MAX_DOCUMENT_CHUNK_BYTES)
      val available = (file.length() - args.offset).coerceAtMost(maxBytes.toLong()).toInt()
      val bytes = ByteArray(available)
      val read = if (available == 0) 0 else RandomAccessFile(file, "r").use { handle ->
        handle.seek(args.offset)
        handle.read(bytes)
      }.coerceAtLeast(0)
      val nextOffset = args.offset + read
      invoke.resolveObject(
        mapOf(
          "dataBase64" to Base64.encodeToString(bytes.copyOf(read), Base64.NO_WRAP),
          "nextOffset" to nextOffset,
          "eof" to (nextOffset >= file.length()),
        ),
      )
    } catch (error: Exception) {
      invoke.reject("Android document chunk could not be read", error)
    }
  }

  @Command
  fun releaseDocument(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(DocumentTokenArgs::class.java)
      openDocuments.remove(validToken(args.token))?.delete()
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("Android document cache could not be released", error)
    }
  }

  @Command
  fun beginSave(invoke: Invoke) {
    if (!pickerActive.compareAndSet(false, true)) {
      invoke.reject("another Android document picker is already open")
      return
    }
    try {
      val args = invoke.parseArgs(BeginSaveDocumentArgs::class.java)
      val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = validMimeType(args.mimeType) ?: "application/octet-stream"
        putExtra(Intent.EXTRA_TITLE, safeDocumentName(args.suggestedName))
        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      }
      startActivityForResult(invoke, intent, "beginSaveResult")
    } catch (error: Exception) {
      pickerActive.set(false)
      invoke.reject("Android save picker could not be opened", error)
    }
  }

  @ActivityCallback
  fun beginSaveResult(invoke: Invoke, result: ActivityResult) {
    pickerActive.set(false)
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      invoke.resolveObject(mapOf("cancelled" to true))
      return
    }
    try {
      val output = activity.contentResolver.openOutputStream(uri, "w")
        ?: throw IllegalArgumentException("selected Android save location cannot be opened")
      val token = UUID.randomUUID().toString()
      saveSessions[token] = SaveSession(uri, output)
      invoke.resolveObject(mapOf("cancelled" to false, "token" to token))
    } catch (error: Exception) {
      invoke.reject("Android save destination could not be prepared", error)
    }
  }

  @Command
  fun writeChunk(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(WriteDocumentChunkArgs::class.java)
      val session = saveSessions[validToken(args.token)] ?: throw IllegalArgumentException("save token has expired")
      val bytes = Base64.decode(args.dataBase64, Base64.NO_WRAP)
      if (bytes.size > MAX_DOCUMENT_CHUNK_BYTES) throw IllegalArgumentException("save chunk is too large")
      session.output.write(bytes)
      session.bytesWritten += bytes.size
      invoke.resolveObject(mapOf("bytesWritten" to bytes.size, "totalBytesWritten" to session.bytesWritten))
    } catch (error: Exception) {
      invoke.reject("Android document chunk could not be written", error)
    }
  }

  @Command
  fun finishSave(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(DocumentTokenArgs::class.java)
      val token = validToken(args.token)
      val session = saveSessions[token] ?: throw IllegalArgumentException("save token has expired")
      session.output.flush()
      session.output.close()
      saveSessions.remove(token)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("Android document could not be finalized", error)
    }
  }

  @Command
  fun abortSave(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(DocumentTokenArgs::class.java)
      val session = saveSessions.remove(validToken(args.token))
      session?.output?.close()
      session?.uri?.let { activity.contentResolver.delete(it, null, null) }
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("Android document save could not be aborted", error)
    }
  }

  override fun onDestroy(activity: AppCompatActivity) {
    destroyed.set(true)
    pickerActive.set(false)
    ioExecutor.shutdownNow()
    openDocuments.values.forEach(File::delete)
    openDocuments.clear()
    saveSessions.values.forEach { session -> runCatching { session.output.close() } }
    saveSessions.clear()
  }

  private fun completeOnUiThread(action: () -> Unit) {
    if (destroyed.get()) return
    activity.runOnUiThread {
      if (!destroyed.get()) action()
    }
  }

  private data class DocumentMetadata(
    val fileName: String,
    val mimeType: String?,
    val lastModified: Long,
  )

  private fun queryMetadata(uri: Uri): DocumentMetadata {
    var fileName = "imported-document"
    var lastModified = System.currentTimeMillis()
    activity.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { index ->
          fileName = cursor.getString(index) ?: fileName
        }
        cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED).takeIf { it >= 0 }?.let { index ->
          if (!cursor.isNull(index)) lastModified = cursor.getLong(index)
        }
      }
    }
    return DocumentMetadata(fileName, activity.contentResolver.getType(uri), lastModified)
  }

  private fun queryTreeDisplayName(uri: Uri): String {
    activity.contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
      ?.use { cursor ->
        if (cursor.moveToFirst() && !cursor.isNull(0)) return safeDocumentName(cursor.getString(0))
      }
    return "선택한 폴더"
  }

  private fun scanDocumentChildren(
    treeUri: Uri,
    parentDocumentId: String,
    parentPath: String,
    recursive: Boolean,
    maxEntries: Int,
    output: MutableList<Map<String, Any?>>,
  ) {
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocumentId)
    val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_SIZE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    )
    val childCursor = activity.contentResolver.query(childrenUri, projection, null, null, null)
      ?: throw IllegalStateException("folder provider returned no child cursor")
    childCursor.use { cursor ->
      while (cursor.moveToNext()) {
        val documentId = cursor.getString(0) ?: continue
        val displayName = safeDocumentName(cursor.getString(1) ?: "unnamed-document")
        val mimeType = cursor.getString(2)
        val relativePath = if (parentPath.isEmpty()) displayName else "$parentPath/$displayName"
        if (mimeType == DocumentsContract.Document.MIME_TYPE_DIR) {
          if (recursive) {
            scanDocumentChildren(treeUri, documentId, relativePath, true, maxEntries, output)
          }
          continue
        }
        if (output.size >= maxEntries) throw IllegalStateException("folder contains more than $maxEntries files")
        output.add(
          mapOf(
            "documentId" to documentId,
            "relativePath" to relativePath,
            "fileName" to displayName,
            "mimeType" to mimeType,
            "byteLength" to if (cursor.isNull(3)) 0L else cursor.getLong(3).coerceAtLeast(0L),
            "lastModified" to if (cursor.isNull(4)) 0L else cursor.getLong(4).coerceAtLeast(0L),
          ),
        )
      }
    }
  }

  private fun folderUri(value: String): Uri {
    val folderId = validFolderId(value)
    val stored = folderPreferences.getString(folderId, null)
      ?: throw IllegalArgumentException("folder permission is no longer available")
    return Uri.parse(stored)
  }

  private fun validFolderId(value: String): String = validToken(value)

  private fun validDocumentId(value: String): String {
    val documentId = value.trim()
    if (documentId.isEmpty() || documentId.length > 2048 || documentId.any { it.code < 32 }) {
      throw IllegalArgumentException("document id is invalid")
    }
    return documentId
  }

  private fun validToken(value: String): String {
    val token = value.trim()
    if (!token.matches(Regex("^[a-fA-F0-9-]{36}$"))) throw IllegalArgumentException("document token is invalid")
    return token
  }

  private fun validMimeType(value: String): String? {
    val mimeType = value.trim().lowercase()
    return mimeType.takeIf { it.matches(Regex("^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$")) }
  }

  private fun safeDocumentName(value: String): String {
    val safe = value.trim().replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").take(180)
    return safe.ifEmpty { "noveldesk-document" }
  }

  private fun mimeTypeForName(fileName: String): String = when (fileName.substringAfterLast('.', "").lowercase()) {
    "txt", "md", "markdown" -> "text/plain"
    "epub" -> "application/epub+zip"
    "pdf" -> "application/pdf"
    "zip" -> "application/zip"
    "cbz" -> "application/vnd.comicbook+zip"
    "rar", "cbr" -> "application/vnd.comicbook-rar"
    "7z", "cb7" -> "application/x-7z-compressed"
    else -> "application/octet-stream"
  }
}
