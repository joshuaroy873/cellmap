"""Shared schema constants for CSV import and website queries."""

import re
from datetime import datetime

SCHEMA_VERSION = 3
NULL_FILTER_VALUE = "__null__"

CATEGORY_TYPES = {
    "radio": {"LTE": "lte_radio", "NR": "nr_radio"},
    "neighbor": {"LTE": "lte_radio_neighbor", "NR": "nr_radio_neighbor"},
    "pdsch": {"LTE": "lte_pdsch", "NR": "nr_pdsch"},
    "pusch": {"LTE": "lte_pusch", "NR": "nr_pusch"},
}

METRICS = {
    "radio": {
        "rsrp_dbm": ("RSRP / SS-RSRP", "dBm"),
        "rsrq_db": ("RSRQ / SS-RSRQ", "dB"),
        "rssi_dbm": ("RSSI", "dBm"),
        "sinr_db": ("SINR / SS-SINR", "dB"),
    },
    "neighbor": {
        "rsrp_dbm": ("RSRP / SS-RSRP", "dBm"),
        "rsrq_db": ("RSRQ / SS-RSRQ", "dB"),
        "rssi_dbm": ("RSSI", "dBm"),
        "sinr_db": ("SS-SINR", "dB"),
    },
    "pdsch": {
        "throughput_mbps": ("Net PDSCH throughput", "Mbps"),
        "mcs": ("MCS", ""),
        "avg_pdsch_layers": ("Average PDSCH layers", ""),
        "pdsch_rbs": ("PDSCH RBs", ""),
        "bler": ("PDSCH BLER", ""),
    },
    "pusch": {
        "throughput_mbps": ("Net PUSCH throughput", "Mbps"),
        "mcs": ("MCS", ""),
        "avg_pusch_layers": ("Average PUSCH layers", ""),
        "pusch_rbs": ("PUSCH RBs", ""),
    },
}

DETAIL_FIELDS = {
    "radio": [
        "dl_channel_number",
        "ul_channel_number",
        "dl_bandwidth_mhz",
        "ul_bandwidth_mhz",
        "dl_scs_khz",
        "cell_type",
    ],
    "neighbor": [
        "dl_channel_number",
        "ul_channel_number",
        "dl_scs_khz",
        "is_serving_beam",
    ],
    "pdsch": [
        "dl_channel_number",
        "dl_bandwidth_mhz",
        "dl_bandwidth_aggregated_mhz",
        "dl_scs_khz",
        "cell_type",
        "modulation",
    ],
    "pusch": [
        "ul_channel_number",
        "ul_bandwidth_mhz",
        "ul_bandwidth_aggregated_mhz",
        "ul_scs_khz",
        "cell_type",
        "modulation",
    ],
}

COMMON_COLUMNS = [
    ("measured_at", "TIMESTAMP", ["time", "timestamp"]),
    ("database_name", "VARCHAR", ["database", "database_name"]),
    ("collection_name", "VARCHAR", ["collection", "collection_name"]),
    ("latitude", "DOUBLE", ["latitude"]),
    ("longitude", "DOUBLE", ["longitude"]),
    ("operator_name", "VARCHAR", ["operator", "operator_name"]),
    ("model", "VARCHAR", ["model"]),
]

MEASUREMENT_SCHEMAS = {
    "lte_radio": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_lte", "pci"]),
        ("ssb_index", "BIGINT", []),
        ("dl_channel_number", "BIGINT", ["dl_earfcn"]),
        ("ul_channel_number", "BIGINT", ["ul_earfcn"]),
        ("dl_bandwidth_mhz", "DOUBLE", ["dl_bandwidth"]),
        ("dl_bandwidth_aggregated_mhz", "DOUBLE", ["dl_bandwidth_aggregated"]),
        ("ul_bandwidth_mhz", "DOUBLE", ["ul_bandwidth"]),
        ("ul_bandwidth_aggregated_mhz", "DOUBLE", ["ul_bandwidth_aggregated"]),
        ("dl_scs_khz", "BIGINT", []),
        ("cell_type", "VARCHAR", ["cell_type"]),
        ("rsrp_dbm", "DOUBLE", ["rsrp"]),
        ("rsrq_db", "DOUBLE", ["rsrq"]),
        ("rssi_dbm", "DOUBLE", ["rssi_lte", "rssi"]),
        ("sinr_db", "DOUBLE", ["sinr"]),
    ],
    "lte_radio_neighbor": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_lte", "pci"]),
        ("ssb_index", "BIGINT", []),
        ("dl_channel_number", "BIGINT", ["dl_earfcn"]),
        ("ul_channel_number", "BIGINT", ["ul_earfcn"]),
        ("dl_scs_khz", "BIGINT", []),
        ("is_serving_beam", "BOOLEAN", []),
        ("rsrp_dbm", "DOUBLE", ["rsrp"]),
        ("rsrq_db", "DOUBLE", ["rsrq"]),
        ("rssi_dbm", "DOUBLE", ["rssi"]),
        ("sinr_db", "DOUBLE", []),
    ],
    "lte_pdsch": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_lte", "pci"]),
        ("ssb_index", "BIGINT", []),
        ("dl_channel_number", "BIGINT", ["dl_earfcn"]),
        ("dl_bandwidth_mhz", "DOUBLE", ["dl_bandwidth"]),
        ("dl_bandwidth_aggregated_mhz", "DOUBLE", ["dl_bandwidth_aggregated"]),
        ("dl_scs_khz", "BIGINT", []),
        ("cell_type", "VARCHAR", ["cell_type"]),
        ("throughput_mbps", "DOUBLE", ["lte_net_pdsch_throughput"]),
        ("mcs", "DOUBLE", ["mcs"]),
        ("avg_pdsch_layers", "DOUBLE", ["avg_pdsch_layers"]),
        ("pdsch_rbs", "DOUBLE", ["pdsch_rbs"]),
        ("bler", "DOUBLE", ["bler"]),
        ("modulation", "VARCHAR", ["pdsch_modulation"]),
    ],
    "lte_pusch": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_lte", "pci"]),
        ("ssb_index", "BIGINT", []),
        ("ul_channel_number", "BIGINT", ["ul_earfcn"]),
        ("ul_bandwidth_mhz", "DOUBLE", ["ul_bandwidth"]),
        ("ul_bandwidth_aggregated_mhz", "DOUBLE", ["ul_bandwidth_aggregated"]),
        ("ul_scs_khz", "BIGINT", []),
        ("cell_type", "VARCHAR", ["cell_type"]),
        ("throughput_mbps", "DOUBLE", ["lte_net_pusch_throughput"]),
        ("mcs", "DOUBLE", ["mcs"]),
        ("avg_pusch_layers", "DOUBLE", ["avg_pusch_layers"]),
        ("pusch_rbs", "DOUBLE", ["pusch_rbs"]),
        ("modulation", "VARCHAR", ["pusch_modulation"]),
    ],
    "nr_radio": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_5g_nr", "pci_nr", "pci"]),
        ("ssb_index", "BIGINT", ["ssb_index"]),
        ("dl_channel_number", "BIGINT", ["dl_nrarfcn", "dl_nr_arfcn"]),
        ("ul_channel_number", "BIGINT", ["ul_nrarfcn", "ul_nr_arfcn"]),
        ("dl_bandwidth_mhz", "DOUBLE", ["dl_bandwidth"]),
        ("dl_bandwidth_aggregated_mhz", "DOUBLE", ["dl_bandwidth_aggregated"]),
        ("ul_bandwidth_mhz", "DOUBLE", ["ul_bandwidth"]),
        ("ul_bandwidth_aggregated_mhz", "DOUBLE", ["ul_bandwidth_aggregated"]),
        ("dl_scs_khz", "BIGINT", ["dl_subcarrier_spacing"]),
        ("cell_type", "VARCHAR", ["cell_type"]),
        ("rsrp_dbm", "DOUBLE", ["ssrsrp", "ss_rsrp"]),
        ("rsrq_db", "DOUBLE", ["ssrsrq", "ss_rsrq"]),
        ("rssi_dbm", "DOUBLE", []),
        ("sinr_db", "DOUBLE", ["sssinr", "ss_sinr"]),
    ],
    "nr_radio_neighbor": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_5g_nr", "pci_nr", "pci"]),
        ("ssb_index", "BIGINT", ["ssb_index"]),
        ("dl_channel_number", "BIGINT", ["dl_nrarfcn", "dl_nr_arfcn"]),
        ("ul_channel_number", "BIGINT", ["ul_nrarfcn", "ul_nr_arfcn"]),
        ("dl_scs_khz", "BIGINT", ["dl_subcarrier_spacing"]),
        ("is_serving_beam", "BOOLEAN", ["is_serving_beam"]),
        ("rsrp_dbm", "DOUBLE", ["ssrsrp", "ss_rsrp"]),
        ("rsrq_db", "DOUBLE", ["ssrsrq", "ss_rsrq"]),
        ("rssi_dbm", "DOUBLE", []),
        ("sinr_db", "DOUBLE", ["sssinr", "ss_sinr"]),
    ],
    "nr_pdsch": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_5g_nr", "pci_nr", "pci"]),
        ("ssb_index", "BIGINT", ["ssb_index"]),
        ("dl_channel_number", "BIGINT", ["dl_nrarfcn", "dl_nr_arfcn"]),
        ("dl_bandwidth_mhz", "DOUBLE", ["dl_bandwidth"]),
        ("dl_bandwidth_aggregated_mhz", "DOUBLE", ["dl_bandwidth_aggregated"]),
        ("dl_scs_khz", "BIGINT", ["pdsch_scs"]),
        ("cell_type", "VARCHAR", ["cell_type"]),
        ("throughput_mbps", "DOUBLE", ["5g_nr_net_pdsch_throughput"]),
        ("mcs", "DOUBLE", ["mcs"]),
        ("avg_pdsch_layers", "DOUBLE", ["avg_pdsch_layers"]),
        ("pdsch_rbs", "DOUBLE", ["pdsch_rbs"]),
        ("bler", "DOUBLE", ["pdsch_bler"]),
        ("modulation", "VARCHAR", ["pdsch_modulation"]),
    ],
    "nr_pusch": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_5g_nr", "pci_nr", "pci"]),
        ("ssb_index", "BIGINT", ["ssb_index"]),
        ("ul_channel_number", "BIGINT", ["ul_nrarfcn", "ul_nr_arfcn"]),
        ("ul_bandwidth_mhz", "DOUBLE", ["ul_bandwidth"]),
        ("ul_bandwidth_aggregated_mhz", "DOUBLE", ["ul_bandwidth_aggregated"]),
        ("ul_scs_khz", "BIGINT", ["pusch_scs"]),
        ("cell_type", "VARCHAR", ["cell_type"]),
        ("throughput_mbps", "DOUBLE", ["5g_nr_net_pusch_throughput"]),
        ("mcs", "DOUBLE", ["mcs"]),
        ("avg_pusch_layers", "DOUBLE", ["avg_pusch_layers"]),
        ("pusch_rbs", "DOUBLE", ["pusch_rbs"]),
        ("modulation", "VARCHAR", ["pusch_modulation"]),
    ],
}

DERIVED_COLUMNS = {
    "lte_radio": {
        "technology": "'LTE'",
        "ssb_index": "NULL",
        "dl_scs_khz": "15",
    },
    "lte_radio_neighbor": {
        "technology": "'LTE'",
        "ssb_index": "NULL",
        "dl_scs_khz": "15",
        "is_serving_beam": "NULL",
        "sinr_db": "NULL",
    },
    "lte_pdsch": {
        "technology": "'LTE'",
        "ssb_index": "NULL",
        "dl_scs_khz": "15",
    },
    "lte_pusch": {
        "technology": "'LTE'",
        "ssb_index": "NULL",
        "ul_scs_khz": "15",
    },
    "nr_radio": {"technology": "'NR'", "rssi_dbm": "NULL"},
    "nr_radio_neighbor": {"technology": "'NR'", "rssi_dbm": "NULL"},
    "nr_pdsch": {"technology": "'NR'"},
    "nr_pusch": {"technology": "'NR'"},
}

ROW_FILTERS = {
    "lte_pdsch": [
        (["test_name"], ("Capacity", "Capacity HTTP/FTP")),
        (["direction"], "Downlink"),
        (["test_status"], "Completed"),
    ],
    "nr_pdsch": [
        (["test_name"], ("Capacity", "Capacity HTTP/FTP")),
        (["direction"], "Downlink"),
        (["test_status"], "Completed"),
    ],
    "lte_pusch": [
        (["test_name"], ("Capacity", "Capacity HTTP/FTP")),
        (["direction"], "Uplink"),
        (["test_status"], "Completed"),
    ],
    "nr_pusch": [
        (["test_name"], ("Capacity", "Capacity HTTP/FTP")),
        (["direction"], "Uplink"),
        (["test_status"], "Completed"),
    ],
}

# DuckDB keeps ONE engine per database file per process and shares it between
# every open connection. A SET on any connection therefore changes all of them,
# and connecting with a different config than an open connection is an error.
# Every website connection must go through connect_read_only so the engine is
# always bounded the same way: these caps hold for all concurrent requests.
QUERY_CONFIG = {"threads": "16", "memory_limit": "8GB"}


def connect_read_only(path):
    import duckdb

    return duckdb.connect(str(path), read_only=True, config=QUERY_CONFIG)


TIMESTAMP_PATTERN = re.compile(
    r"(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?"
)


def parse_timestamp(value, label):
    """Parse browser datetime-local text (any fractional-second length) or fail loudly.

    Python 3.10's fromisoformat rejects one- or two-digit fractions such as
    10:52:19.4, which the browser produces after trimming trailing zeros.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text")
    text = value.strip()
    if not text:
        return None
    match = TIMESTAMP_PATTERN.fullmatch(text)
    if not match:
        raise ValueError(f"{label} must look like YYYY-MM-DD HH:MM[:SS[.ffffff]]")
    day, minute, second, fraction = match.groups()
    normalized = f"{day}T{minute}:{second or '00'}.{(fraction or '').ljust(6, '0')}"
    try:
        return datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError(f"{label} is not a valid date and time") from error


FILE_TYPES = {
    "lte_radio": "lte_radio",
    "lte_radio_neig": "lte_radio_neighbor",
    "lte_radio_neighbor": "lte_radio_neighbor",
    "lte_pdsch": "lte_pdsch",
    "lte_pusch": "lte_pusch",
    "nr_radio": "nr_radio",
    "nr_radio_neig": "nr_radio_neighbor",
    "nr_radio_neighbor": "nr_radio_neighbor",
    "nr_pdsch": "nr_pdsch",
    "nr_pusch": "nr_pusch",
}
