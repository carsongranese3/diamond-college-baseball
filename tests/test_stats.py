"""Tests for the stat math, the ?asof= date rule, and the saved season data.

Run: python -m unittest discover -s tests
"""

import datetime
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import boxutil  # noqa: E402
import clock  # noqa: E402
import local_data  # noqa: E402
import stat_agg  # noqa: E402
from flask import Flask  # noqa: E402


class InningsPitched(unittest.TestCase):
    def test_ip_to_outs(self):
        cases = {"6.1": 19, "6.2": 20, "78.0": 234, "7": 21, "0.1": 1, "0": 0, 9: 27}
        for ip, outs in cases.items():
            self.assertEqual(boxutil.ip_to_outs(ip), outs, ip)

    def test_ip_to_outs_bad_input_is_zero(self):
        for bad in ("", None, "abc", "6."):
            self.assertEqual(boxutil.ip_to_outs(bad), 0, bad)

    def test_round_trip(self):
        for outs in range(0, 300):
            self.assertEqual(boxutil.ip_to_outs(boxutil.outs_to_ip(outs)), outs)

    def test_thirds_add_up(self):
        # 6.1 + 2.2 is 9 innings, not 8.3
        total = boxutil.ip_to_outs("6.1") + boxutil.ip_to_outs("2.2")
        self.assertEqual(boxutil.outs_to_ip(total), "9.0")


class Formatting(unittest.TestCase):
    def test_fmt3_drops_leading_zero(self):
        self.assertEqual(boxutil.fmt3(0.374), ".374")
        self.assertEqual(boxutil.fmt3(1.143), "1.143")
        self.assertEqual(boxutil.fmt3(0), ".000")

    def test_fmt_pct(self):
        self.assertEqual(boxutil.fmt_pct(0.123), "12.3%")

    def test_to_int_and_float(self):
        self.assertEqual(boxutil.to_int(" 7 "), 7)
        self.assertEqual(boxutil.to_int("x"), 0)
        self.assertEqual(boxutil.to_float("12.5%"), 12.5)


class Sabermetrics(unittest.TestCase):
    def test_fip(self):
        # 2 HR, 10 BB, 1 HBP, 40 K over 30 IP: (26 + 33 - 80) / 30 + 3.10 = 2.40
        self.assertEqual(boxutil.fip(2, 10, 1, 40, 90), "2.40")

    def test_fip_custom_constant(self):
        self.assertEqual(boxutil.fip(2, 10, 1, 40, 90, constant=4.0), "3.30")

    def test_babip(self):
        # (50 - 5) / (200 - 40 - 5 + 3) = 45 / 158
        self.assertEqual(boxutil.babip(50, 5, 200, 40, 3), boxutil.fmt3(45 / 158))

    def test_per9(self):
        self.assertEqual(boxutil.per9(30, 81), "10.00")   # 30 K in 27 IP

    def test_lob_pct(self):
        # (40 + 10 + 2 - 20) / (40 + 10 + 2 - 1.4 * 5) = 32 / 45
        self.assertEqual(boxutil.lob_pct(40, 10, 2, 20, 5), boxutil.fmt_pct(32 / 45))

    def test_runs_created_and_secondary_avg(self):
        self.assertEqual(boxutil.runs_created(50, 20, 80, 180), boxutil.fmt2(70 * 80 / 200))
        self.assertEqual(boxutil.secondary_avg(80, 50, 20, 5, 1, 180), boxutil.fmt3(54 / 180))

    def test_zero_denominators_render_blank(self):
        self.assertEqual(boxutil.fip(0, 0, 0, 0, 0), "—")
        self.assertEqual(boxutil.babip(0, 0, 0, 0, 0), "—")
        self.assertEqual(boxutil.per9(5, 0), "—")
        self.assertEqual(boxutil.ratio(5, 0), "—")
        self.assertEqual(boxutil.secondary_avg(0, 0, 0, 0, 0, 0), "—")
        self.assertEqual(boxutil.runs_created(0, 0, 0, 0), "—")
        self.assertEqual(boxutil.lob_pct(0, 0, 0, 0, 0), "—")


class AsofDate(unittest.TestCase):
    """clock.asof(): honored only for an exact YYYY-MM-DD inside the season."""

    app = Flask(__name__)

    def asof(self, raw):
        with self.app.test_request_context(f"/?asof={raw}"):
            return clock.asof()

    def test_valid_date(self):
        self.assertEqual(self.asof("2026-04-15"), datetime.date(2026, 4, 15))

    def test_season_edges(self):
        self.assertEqual(self.asof("2026-02-13"), clock.SEASON_START)
        self.assertIsNone(self.asof("2026-02-12"))
        self.assertIsNone(self.asof("2026-07-01"))

    def test_malformed_dates_ignored(self):
        for raw in ("20260415", "2026-4-15", "2026-13-01", "april", ""):
            self.assertIsNone(self.asof(raw), raw)

    def test_today_uses_asof(self):
        with self.app.test_request_context("/?asof=2026-04-15"):
            self.assertEqual(clock.today(), datetime.date(2026, 4, 15))
            self.assertEqual(clock.effective_iso(), "2026-04-15")

    def test_no_request_means_real_date(self):
        self.assertIsNone(clock.asof())
        self.assertEqual(clock.today(), datetime.date.today())


def _sum(rows, key):
    return sum(int(r.get(key) or 0) for r in rows)


class SavedDataReconciles(unittest.TestCase):
    """The precomputed stats/*.json totals must equal a fresh sum of every saved game,
    because ?asof= switches between the two and the numbers must not jump."""

    def test_season_totals_match_per_game_sums(self):
        teams = local_data.team_dirs()
        self.assertGreater(len(teams), 0, "no team folders found under Data/2026")
        checked = 0
        for label, d in teams:
            stats = os.path.join(d, "stats")
            if not os.path.exists(os.path.join(stats, "batting.json")):
                continue
            with open(os.path.join(stats, "batting.json"), encoding="utf-8") as fh:
                bat = json.load(fh)["players"]
            with open(os.path.join(stats, "pitching.json"), encoding="utf-8") as fh:
                pit = json.load(fh)["players"]
            bat2, pit2, _ = stat_agg.aggregate(d, label, None)
            with self.subTest(team=label):
                for key in ("ab", "h", "hr", "bb", "rbi"):
                    self.assertEqual(_sum(bat, key), _sum(bat2, key), f"batting {key}")
                for key in ("outs", "er", "so", "bb"):
                    self.assertEqual(_sum(pit, key), _sum(pit2, key), f"pitching {key}")
            checked += 1
        self.assertGreater(checked, 0)

    def test_asof_before_season_counts_nothing(self):
        label, d = local_data.team_dirs()[0]
        bat, pit, _ = stat_agg.aggregate(d, label, "2026-01-01")
        self.assertEqual(_sum(bat, "ab"), 0)
        self.assertEqual(_sum(pit, "outs"), 0)

    def test_asof_midseason_is_a_subset(self):
        label, d = local_data.team_dirs()[0]
        mid, _, _ = stat_agg.aggregate(d, label, "2026-04-01")
        full, _, _ = stat_agg.aggregate(d, label, None)
        self.assertGreater(_sum(mid, "ab"), 0)
        self.assertLess(_sum(mid, "ab"), _sum(full, "ab"))


if __name__ == "__main__":
    unittest.main()
