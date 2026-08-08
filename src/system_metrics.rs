use anyhow::{Result, bail};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SystemMetrics {
    pub cpu_percent: u8,
    pub memory_percent: u8,
}

pub fn render_status_segment() -> String {
    match sample() {
        Ok(metrics) => format!(
            " · CPU {}% · MEM {}%",
            metrics.cpu_percent, metrics.memory_percent
        ),
        Err(_) => " · CPU -- · MEM --".to_owned(),
    }
}

pub fn sample() -> Result<SystemMetrics> {
    if !sysinfo::IS_SUPPORTED_SYSTEM {
        bail!("system metrics are unsupported on this operating system")
    }

    let mut system = System::new_with_specifics(
        RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
            .with_memory(MemoryRefreshKind::nothing().with_ram()),
    );
    // CPU usage is computed from two readings. The crate's interval is
    // platform-specific and is the shortest interval that yields a useful
    // reading on the current OS.
    system.refresh_cpu_usage();
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_cpu_usage();
    system.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());

    let total_memory = system.total_memory();
    if total_memory == 0 {
        bail!("system reported no physical memory")
    }
    let available_memory = system.available_memory().min(total_memory);
    let used_memory = total_memory.saturating_sub(available_memory);

    Ok(SystemMetrics {
        cpu_percent: percent(system.global_cpu_usage()),
        memory_percent: ratio_percent(used_memory, total_memory),
    })
}

fn percent(value: f32) -> u8 {
    if !value.is_finite() {
        return 0;
    }
    value.round().clamp(0.0, 100.0) as u8
}

fn ratio_percent(numerator: u64, denominator: u64) -> u8 {
    if denominator == 0 {
        return 0;
    }
    let value = (numerator as f64 / denominator as f64) * 100.0;
    value.round().clamp(0.0, 100.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentages_are_finite_and_clamped() {
        assert_eq!(percent(-4.0), 0);
        assert_eq!(percent(12.4), 12);
        assert_eq!(percent(12.6), 13);
        assert_eq!(percent(104.0), 100);
        assert_eq!(percent(f32::NAN), 0);
        assert_eq!(ratio_percent(1, 3), 33);
        assert_eq!(ratio_percent(4, 3), 100);
        assert_eq!(ratio_percent(1, 0), 0);
    }

    #[test]
    fn status_segment_has_a_stable_compact_shape() {
        let rendered = render_status_segment();
        assert!(rendered.starts_with(" · CPU "));
        assert!(rendered.contains(" · MEM "));
        assert!(rendered.ends_with('%'));
    }
}
