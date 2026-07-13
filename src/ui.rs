use std::io::{self, IsTerminal};

use clap::ValueEnum;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum DeviceColor {
    #[default]
    Emerald,
    Cyan,
    Blue,
    Violet,
    Amber,
    Rose,
}

impl DeviceColor {
    pub fn ansi(self) -> u8 {
        match self {
            Self::Emerald => 32,
            Self::Cyan => 36,
            Self::Blue => 34,
            Self::Violet => 35,
            Self::Amber => 33,
            Self::Rose => 31,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Emerald => "emerald",
            Self::Cyan => "cyan",
            Self::Blue => "blue",
            Self::Violet => "violet",
            Self::Amber => "amber",
            Self::Rose => "rose",
        }
    }

    pub fn from_name(name: &str) -> Self {
        const COLORS: [DeviceColor; 6] = [
            DeviceColor::Emerald,
            DeviceColor::Cyan,
            DeviceColor::Blue,
            DeviceColor::Violet,
            DeviceColor::Amber,
            DeviceColor::Rose,
        ];
        let hash = name.bytes().fold(0usize, |hash, byte| {
            hash.wrapping_mul(31).wrapping_add(byte as usize)
        });
        COLORS[hash % COLORS.len()]
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Ui {
    color: bool,
}

impl Ui {
    pub fn new(no_color: bool) -> Self {
        Self {
            color: !no_color
                && std::env::var_os("NO_COLOR").is_none()
                && io::stdout().is_terminal(),
        }
    }

    pub fn diamond(self, color: DeviceColor) -> String {
        if self.color {
            format!("\x1b[{}m◆\x1b[0m", color.ansi())
        } else {
            "◆".into()
        }
    }

    pub fn success(self, message: impl AsRef<str>) {
        if self.color {
            println!("\x1b[32m✓\x1b[0m {}", message.as_ref());
        } else {
            println!("✓ {}", message.as_ref());
        }
    }

    pub fn muted(self, message: impl AsRef<str>) {
        if self.color {
            println!("\x1b[2m{}\x1b[0m", message.as_ref());
        } else {
            println!("{}", message.as_ref());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_colors_are_stable() {
        assert_eq!(
            DeviceColor::from_name("alpha").label(),
            DeviceColor::from_name("alpha").label()
        );
    }
}
