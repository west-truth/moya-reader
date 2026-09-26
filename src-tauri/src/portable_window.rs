use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, WebviewWindow, WindowEvent};

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct WindowBounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) maximized: bool,
}

pub(crate) fn path(root: &Path) -> PathBuf {
    root.join("data/window.json")
}

pub(crate) fn restore(app: &AppHandle, path: &Path) -> Option<WindowBounds> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    let saved: WindowBounds = serde_json::from_slice(&bytes).ok()?;
    if ![saved.x, saved.y, saved.width, saved.height]
        .iter()
        .all(|value| value.is_finite())
        || saved.width < 720.0
        || saved.height < 640.0
        || saved.width > 10000.0
        || saved.height > 10000.0
    {
        return None;
    }
    let monitors = app.available_monitors().ok()?;
    let visible_monitor = monitors.iter().find(|monitor| {
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        let left = work.position.x as f64 / scale;
        let top = work.position.y as f64 / scale;
        let right = left + work.size.width as f64 / scale;
        let bottom = top + work.size.height as f64 / scale;
        saved.x + 200.0 < right
            && saved.y + 120.0 < bottom
            && saved.x + saved.width - 200.0 > left
            && saved.y + saved.height - 120.0 > top
    });
    let visible = visible_monitor.is_some();
    let monitor = visible_monitor.or_else(|| monitors.first())?;
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let left = work.position.x as f64 / scale;
    let top = work.position.y as f64 / scale;
    let width = work.size.width as f64 / scale;
    let height = work.size.height as f64 / scale;
    let window_width = saved.width.min(width.max(720.0));
    let window_height = saved.height.min(height.max(640.0));
    let (x, y) = if visible
        && saved.x >= left - saved.width + 200.0
        && saved.x < left + width - 200.0
        && saved.y >= top - saved.height + 120.0
        && saved.y < top + height - 120.0
    {
        (
            saved.x.clamp(left, (left + width - window_width).max(left)),
            saved.y.clamp(top, (top + height - window_height).max(top)),
        )
    } else {
        (
            left + (width - window_width).max(0.0) / 2.0,
            top + (height - window_height).max(0.0) / 2.0,
        )
    };
    Some(WindowBounds {
        x,
        y,
        width: window_width,
        height: window_height,
        maximized: saved.maximized,
    })
}

fn save(path: &Path, state: &WindowBounds) {
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(bytes) = serde_json::to_vec(state) {
        let _ = std::fs::write(path, bytes);
    }
}

pub(crate) fn track(window: &WebviewWindow, path: PathBuf, restored: Option<WindowBounds>) {
    let mut initial = restored.unwrap_or(WindowBounds {
        x: 0.0,
        y: 0.0,
        width: 1280.0,
        height: 820.0,
        maximized: false,
    });
    initial.maximized = window.is_maximized().unwrap_or(initial.maximized);
    if !initial.maximized {
        let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
        if let Ok(position) = window.outer_position() {
            initial.x = position.x as f64 / scale;
            initial.y = position.y as f64 / scale;
        }
        if let Ok(size) = window.inner_size() {
            initial.width = size.width as f64 / scale;
            initial.height = size.height as f64 / scale;
        }
    }
    let state = Arc::new(Mutex::new(initial));
    let (sender, receiver) = std::sync::mpsc::channel::<WindowBounds>();
    let save_path = path.clone();
    std::thread::spawn(move || {
        while let Ok(mut latest) = receiver.recv() {
            while let Ok(next) = receiver.recv_timeout(Duration::from_millis(400)) {
                latest = next;
            }
            save(&save_path, &latest);
        }
    });
    let watched = window.clone();
    window.on_window_event(move |event| {
        if !matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
                | WindowEvent::CloseRequested { .. }
        ) {
            return;
        }
        let maximized = watched.is_maximized().unwrap_or(false);
        let scale = watched.scale_factor().unwrap_or(1.0);
        if !scale.is_finite() || scale <= 0.0 {
            return;
        }
        let Ok(mut value) = state.lock() else {
            return;
        };
        value.maximized = maximized;
        if !maximized {
            if let Ok(position) = watched.outer_position() {
                value.x = position.x as f64 / scale;
                value.y = position.y as f64 / scale;
            }
            if let Ok(size) = watched.inner_size() {
                value.width = size.width as f64 / scale;
                value.height = size.height as f64 / scale;
            }
        }
        let snapshot = value.clone();
        drop(value);
        let _ = sender.send(snapshot.clone());
        if matches!(event, WindowEvent::CloseRequested { .. }) {
            save(&path, &snapshot);
        }
    });
}
