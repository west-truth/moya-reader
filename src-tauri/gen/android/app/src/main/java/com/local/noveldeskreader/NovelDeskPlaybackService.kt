package com.local.noveldeskreader

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

class NovelDeskPlaybackService : MediaSessionService() {
  data class PlaybackFile(
    val utteranceId: String,
    val file: File,
    val title: String?,
    val album: String?,
    val artist: String?,
    val volume: Float,
    val trackingJson: String?,
  )

  data class PlaybackSnapshot(
    val active: Boolean,
    val playing: Boolean,
    val paused: Boolean,
    val utteranceId: String?,
    val itemIndex: Int,
    val positionMs: Long,
    val itemCount: Int,
    val updatedAtMs: Long,
    val trackingJson: String?,
  )

  private lateinit var player: ExoPlayer
  private lateinit var mediaSession: MediaSession
  private val queueItems = LinkedHashMap<String, PlaybackFile>()
  private val snapshotHandler = Handler(Looper.getMainLooper())
  private val snapshotTicker = object : Runnable {
    override fun run() {
      if (player.mediaItemCount > 0) persistSnapshot()
      snapshotHandler.postDelayed(this, SNAPSHOT_INTERVAL_MS)
    }
  }
  private var activeUtteranceId: String? = null
  private var startPublishedFor: String? = null

  override fun onCreate() {
    super.onCreate()
    activeService = this
    player = ExoPlayer.Builder(this)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(C.USAGE_MEDIA)
          .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
          .build(),
        true,
      )
      .setHandleAudioBecomingNoisy(true)
      .build()
    player.addListener(
      object : Player.Listener {
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
          val previous = activeUtteranceId
          val next = mediaItem?.mediaId
          if (previous != null && previous != next) finishItem(previous, "end")
          activeUtteranceId = next
          startPublishedFor = null
          next?.let { queueItems[it] }?.let { player.volume = it.volume.coerceIn(0f, 1f) }
          if (player.playWhenReady && player.playbackState == Player.STATE_READY) publishStart()
          persistSnapshot()
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
          if (playbackState == Player.STATE_READY && player.playWhenReady) publishStart()
          if (playbackState == Player.STATE_ENDED) {
            activeUtteranceId?.let { finishItem(it, "end") }
            activeUtteranceId = null
            startPublishedFor = null
            player.clearMediaItems()
            cleanupQueueFiles()
            clearPersistedSnapshot()
            stopSelf()
          }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
          if (isPlaying) publishStart()
          persistSnapshot()
        }

        override fun onPositionDiscontinuity(
          oldPosition: Player.PositionInfo,
          newPosition: Player.PositionInfo,
          reason: Int,
        ) {
          persistSnapshot()
        }

        override fun onPlayerError(error: PlaybackException) {
          activeUtteranceId?.let { publish(it, "error", error.errorCodeName) }
          activeUtteranceId = null
          startPublishedFor = null
          player.clearMediaItems()
          cleanupQueueFiles()
          clearPersistedSnapshot()
          stopSelf()
        }
      },
    )
    mediaSession = MediaSession.Builder(this, player).build()
    restorePersistedQueue()
    snapshotHandler.postDelayed(snapshotTicker, SNAPSHOT_INTERVAL_MS)
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = mediaSession

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_PLAY_FILES -> playFiles(intent)
      ACTION_PAUSE -> {
        player.pause()
        persistSnapshot()
      }
      ACTION_RESUME -> {
        player.play()
        persistSnapshot()
      }
      ACTION_STOP -> {
        activeUtteranceId?.let { publish(it, "stopped") }
        activeUtteranceId = null
        startPublishedFor = null
        player.stop()
        player.clearMediaItems()
        cleanupQueueFiles()
        clearPersistedSnapshot()
        stopSelf()
      }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    snapshotHandler.removeCallbacks(snapshotTicker)
    if (player.mediaItemCount > 0) persistSnapshot()
    mediaSession.release()
    player.release()
    activeUtteranceId = null
    if (activeService === this) activeService = null
    super.onDestroy()
  }

  private fun playFiles(intent: Intent) {
    val ids = intent.getStringArrayListExtra(EXTRA_UTTERANCE_IDS).orEmpty()
    val paths = intent.getStringArrayListExtra(EXTRA_FILE_PATHS).orEmpty()
    val titles = intent.getStringArrayListExtra(EXTRA_TITLES).orEmpty()
    val albums = intent.getStringArrayListExtra(EXTRA_ALBUMS).orEmpty()
    val artists = intent.getStringArrayListExtra(EXTRA_ARTISTS).orEmpty()
    val volumes = intent.getFloatArrayExtra(EXTRA_VOLUMES) ?: floatArrayOf()
    val tracking = intent.getStringArrayListExtra(EXTRA_TRACKING_JSON).orEmpty()
    if (ids.isEmpty() || ids.size != paths.size) return

    activeUtteranceId?.let { publish(it, "stopped") }
    player.stop()
    player.clearMediaItems()
    cleanupQueueFiles()
    activeUtteranceId = null
    startPublishedFor = null

    val mediaItems = ArrayList<MediaItem>()
    ids.indices.forEach { index ->
      val utteranceId = ids[index].trim()
      val file = File(paths[index])
      if (utteranceId.isEmpty() || !file.isFile) return@forEach
      val playbackFile = PlaybackFile(
        utteranceId = utteranceId,
        file = file,
        title = titles.getOrNull(index)?.takeIf { it.isNotEmpty() },
        album = albums.getOrNull(index)?.takeIf { it.isNotEmpty() },
        artist = artists.getOrNull(index)?.takeIf { it.isNotEmpty() },
        volume = (volumes.getOrNull(index) ?: 1f).coerceIn(0f, 1f),
        trackingJson = tracking.getOrNull(index)?.takeIf { it.isNotEmpty() },
      )
      queueItems[utteranceId] = playbackFile
      val metadata = MediaMetadata.Builder()
        .setTitle(playbackFile.title ?: "모야")
        .setAlbumTitle(playbackFile.album)
        .setArtist(playbackFile.artist)
        .build()
      mediaItems += MediaItem.Builder()
        .setMediaId(utteranceId)
        .setUri(Uri.fromFile(file))
        .setMediaMetadata(metadata)
        .build()
    }
    if (mediaItems.isEmpty()) return
    player.volume = queueItems[mediaItems.first().mediaId]?.volume ?: 1f
    player.setMediaItems(mediaItems)
    player.prepare()
    player.play()
    persistSnapshot()
  }

  private fun publishStart() {
    val utteranceId = activeUtteranceId ?: return
    if (startPublishedFor == utteranceId) return
    startPublishedFor = utteranceId
    publish(utteranceId, "start")
  }

  private fun finishItem(utteranceId: String, phase: String) {
    publish(utteranceId, phase)
    if (activeUtteranceId == utteranceId) activeUtteranceId = null
  }

  private fun cleanupQueueFiles() {
    queueItems.values.forEach { it.file.delete() }
    queueItems.clear()
  }

  private fun currentSnapshot(): PlaybackSnapshot {
    val itemCount = queueItems.size
    val index = activeUtteranceId?.let { queueItems.keys.indexOf(it) }?.coerceAtLeast(0) ?: 0
    val active = itemCount > 0 && activeUtteranceId != null
    return PlaybackSnapshot(
      active = active,
      playing = active && player.isPlaying,
      paused = active && !player.playWhenReady,
      utteranceId = activeUtteranceId,
      itemIndex = index,
      positionMs = if (active) player.currentPosition.coerceAtLeast(0L) else 0L,
      itemCount = itemCount,
      updatedAtMs = System.currentTimeMillis(),
      trackingJson = activeUtteranceId?.let { queueItems[it]?.trackingJson },
    )
  }

  private fun persistSnapshot() {
    if (player.mediaItemCount <= 0 || queueItems.isEmpty()) return
    val snapshot = currentSnapshot()
    val items = JSONArray()
    queueItems.values.forEach { item ->
      items.put(
        JSONObject()
          .put("id", item.utteranceId)
          .put("path", item.file.absolutePath)
          .put("title", item.title ?: JSONObject.NULL)
          .put("album", item.album ?: JSONObject.NULL)
          .put("artist", item.artist ?: JSONObject.NULL)
          .put("volume", item.volume.toDouble())
          .put("trackingJson", item.trackingJson ?: JSONObject.NULL),
      )
    }
    getSharedPreferences(SNAPSHOT_PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putString(
        SNAPSHOT_KEY,
        JSONObject()
          .put("schemaVersion", 1)
          .put("items", items)
          .put("itemIndex", snapshot.itemIndex)
          .put("positionMs", snapshot.positionMs)
          .put("playWhenReady", player.playWhenReady)
          .put("updatedAtMs", snapshot.updatedAtMs)
          .toString(),
      )
      .apply()
  }

  private fun restorePersistedQueue() {
    val stored = readPersistedJson(this) ?: return
    try {
      val rows = stored.getJSONArray("items")
      val restored = ArrayList<PlaybackFile>()
      for (index in 0 until rows.length()) {
        val row = rows.getJSONObject(index)
        val file = File(row.getString("path"))
        if (!file.isFile || file.parentFile?.canonicalFile != File(cacheDir, "tts-playback").canonicalFile) continue
        restored += PlaybackFile(
          utteranceId = row.getString("id"),
          file = file,
          title = row.optString("title").takeIf { it.isNotEmpty() && it != "null" },
          album = row.optString("album").takeIf { it.isNotEmpty() && it != "null" },
          artist = row.optString("artist").takeIf { it.isNotEmpty() && it != "null" },
          volume = row.optDouble("volume", 1.0).toFloat().coerceIn(0f, 1f),
          trackingJson = row.optString("trackingJson").takeIf { it.isNotEmpty() && it != "null" },
        )
      }
      if (restored.isEmpty()) {
        clearPersistedSnapshot()
        return
      }
      restored.forEach { queueItems[it.utteranceId] = it }
      player.setMediaItems(restored.map(::mediaItemFor))
      val itemIndex = stored.optInt("itemIndex", 0).coerceIn(0, restored.lastIndex)
      val positionMs = stored.optLong("positionMs", 0L).coerceAtLeast(0L)
      activeUtteranceId = restored[itemIndex].utteranceId
      player.volume = restored[itemIndex].volume
      player.seekTo(itemIndex, positionMs)
      player.prepare()
      if (stored.optBoolean("playWhenReady", false)) player.play()
      persistSnapshot()
    } catch (_: Exception) {
      cleanupQueueFiles()
      clearPersistedSnapshot()
    }
  }

  private fun mediaItemFor(item: PlaybackFile): MediaItem = MediaItem.Builder()
    .setMediaId(item.utteranceId)
    .setUri(Uri.fromFile(item.file))
    .setMediaMetadata(
      MediaMetadata.Builder()
        .setTitle(item.title ?: "모야")
        .setAlbumTitle(item.album)
        .setArtist(item.artist)
        .build(),
    )
    .build()

  private fun clearPersistedSnapshot() {
    getSharedPreferences(SNAPSHOT_PREFERENCES, Context.MODE_PRIVATE).edit().remove(SNAPSHOT_KEY).apply()
  }

  private fun publish(utteranceId: String, phase: String, message: String? = null) {
    sendBroadcast(
      Intent(ACTION_PLAYBACK_EVENT)
        .setPackage(packageName)
        .putExtra(EXTRA_UTTERANCE_ID, utteranceId)
        .putExtra(EXTRA_PHASE, phase)
        .putExtra(EXTRA_MESSAGE, message),
    )
  }

  companion object {
    const val ACTION_PLAYBACK_EVENT = "com.local.noveldeskreader.PLAYBACK_EVENT"
    const val EXTRA_UTTERANCE_ID = "utteranceId"
    const val EXTRA_PHASE = "phase"
    const val EXTRA_MESSAGE = "message"

    private const val ACTION_PLAY_FILES = "com.local.noveldeskreader.PLAY_FILES"
    private const val ACTION_PAUSE = "com.local.noveldeskreader.PAUSE"
    private const val ACTION_RESUME = "com.local.noveldeskreader.RESUME"
    private const val ACTION_STOP = "com.local.noveldeskreader.STOP"
    private const val EXTRA_UTTERANCE_IDS = "utteranceIds"
    private const val EXTRA_FILE_PATHS = "filePaths"
    private const val EXTRA_TITLES = "titles"
    private const val EXTRA_ALBUMS = "albums"
    private const val EXTRA_ARTISTS = "artists"
    private const val EXTRA_VOLUMES = "volumes"
    private const val EXTRA_TRACKING_JSON = "trackingJson"
    private const val SNAPSHOT_PREFERENCES = "noveldesk_playback"
    private const val SNAPSHOT_KEY = "media3_queue_v1"
    private const val SNAPSHOT_INTERVAL_MS = 5_000L
    @Volatile private var activeService: NovelDeskPlaybackService? = null

    fun playbackSnapshot(context: Context): PlaybackSnapshot {
      activeService?.let { return it.currentSnapshot() }
      val stored = readPersistedJson(context)
      val rows = stored?.optJSONArray("items")
      val index = stored?.optInt("itemIndex", 0) ?: 0
      val item = rows?.optJSONObject(index)
      val active = item != null && File(item.optString("path")).isFile
      val playWhenReady = stored?.optBoolean("playWhenReady", false) ?: false
      return PlaybackSnapshot(
        active = active,
        playing = active && playWhenReady,
        paused = active && !playWhenReady,
        utteranceId = item?.optString("id")?.takeIf { it.isNotEmpty() },
        itemIndex = if (active) index else 0,
        positionMs = stored?.optLong("positionMs", 0L)?.coerceAtLeast(0L) ?: 0L,
        itemCount = rows?.length() ?: 0,
        updatedAtMs = stored?.optLong("updatedAtMs", 0L) ?: 0L,
        trackingJson = item?.optString("trackingJson")?.takeIf { it.isNotEmpty() && it != "null" },
      )
    }

    private fun readPersistedJson(context: Context): JSONObject? = try {
      context.getSharedPreferences(SNAPSHOT_PREFERENCES, Context.MODE_PRIVATE)
        .getString(SNAPSHOT_KEY, null)
        ?.let(::JSONObject)
    } catch (_: Exception) {
      null
    }

    fun playFiles(context: Context, files: List<PlaybackFile>) {
      require(files.isNotEmpty()) { "Android background playback queue is empty." }
      ContextCompat.startForegroundService(
        context,
        Intent(context, NovelDeskPlaybackService::class.java)
          .setAction(ACTION_PLAY_FILES)
          .putStringArrayListExtra(EXTRA_UTTERANCE_IDS, ArrayList(files.map { it.utteranceId }))
          .putStringArrayListExtra(EXTRA_FILE_PATHS, ArrayList(files.map { it.file.absolutePath }))
          .putStringArrayListExtra(EXTRA_TITLES, ArrayList(files.map { it.title.orEmpty() }))
          .putStringArrayListExtra(EXTRA_ALBUMS, ArrayList(files.map { it.album.orEmpty() }))
          .putStringArrayListExtra(EXTRA_ARTISTS, ArrayList(files.map { it.artist.orEmpty() }))
          .putExtra(EXTRA_VOLUMES, files.map { it.volume }.toFloatArray())
          .putStringArrayListExtra(EXTRA_TRACKING_JSON, ArrayList(files.map { it.trackingJson.orEmpty() })),
      )
    }

    fun pause(context: Context) = send(context, ACTION_PAUSE)
    fun resume(context: Context) = send(context, ACTION_RESUME)
    fun stop(context: Context) = send(context, ACTION_STOP)

    private fun send(context: Context, action: String) {
      context.startService(Intent(context, NovelDeskPlaybackService::class.java).setAction(action))
    }
  }
}
