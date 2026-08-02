use anyhow::Result;
use serde::Serialize;
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkHint {
    version: u32,
    machine_id: Uuid,
    tailscale: Option<TailscaleHint>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleHint {
    dns_name: String,
}

/// Inspect optional local network metadata without changing Fleet or Tailscale state.
///
/// An unavailable, stopped, or logged-out Tailscale client is equivalent to no
/// hint. The adapter itself owns command deadlines, output limits, and parsing.
pub fn inspect(machine_id: Uuid) -> Result<NetworkHint> {
    let dns_name = crate::tailscale::self_dns_name().ok().flatten();
    Ok(from_dns_name(machine_id, dns_name))
}

fn from_dns_name(machine_id: Uuid, dns_name: Option<String>) -> NetworkHint {
    NetworkHint {
        version: SCHEMA_VERSION,
        machine_id,
        tailscale: dns_name.map(|dns_name| TailscaleHint { dns_name }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_contains_machine_identity_and_optional_dns_name() {
        let id = Uuid::nil();
        let report = from_dns_name(id, Some("emerald.example.ts.net".into()));
        assert_eq!(
            serde_json::to_value(report).unwrap(),
            serde_json::json!({
                "version": 1,
                "machineId": id,
                "tailscale": { "dnsName": "emerald.example.ts.net" }
            })
        );
    }

    #[test]
    fn schema_represents_an_absent_client_without_omitting_the_field() {
        let id = Uuid::nil();
        let report = from_dns_name(id, None);
        assert_eq!(
            serde_json::to_value(report).unwrap(),
            serde_json::json!({
                "version": 1,
                "machineId": id,
                "tailscale": null
            })
        );
    }
}
