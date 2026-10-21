"""Offline execution of the actual Pi helper; every external command is mocked."""
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

sys.dont_write_bytecode = True
source = Path(__file__).resolve().parents[1] / 'scripts/pi/qp-speak-guarded'
loader = importlib.machinery.SourceFileLoader('guarded_speech', str(source))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)
ADDRESS = 'AA:BB:CC:DD:EE:0F'
FINGERPRINT = hashlib.sha256(ADDRESS.encode()).hexdigest()[:12]
BOOT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
CLIP = 'speech-' + 'a' * 64


class Launched(BaseException):
    pass


class GuardedSpeechTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='qp-guarded-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.state = self.root / 'state/quiet-porch'
        self.state.mkdir(parents=True)
        self.clips = self.root / 'clips'
        self.clips.mkdir()
        (self.clips / (CLIP + '.wav')).write_bytes(b'synthetic')
        self.result = self.state / 'guarded-fixture.json'
        self.time = 100000
        self.volume = 'Volume: 1.00'
        self.address = ADDRESS
        self.command_delay = 0
        self.args = ['dispatch', 'fixture', '1791400000000', CLIP, FINGERPRINT, BOOT, '101000']
        self.start(patch.dict(os.environ, {'XDG_STATE_HOME': str(self.root / 'state'), 'QP_CLIP_DIR': str(self.clips)}))
        self.start(patch.object(helper, 'APPROVED_SPEAKER', FINGERPRINT))
        self.start(patch.object(helper, 'now_ms', lambda: self.time))
        self.start(patch.object(helper, 'boot_id', lambda: BOOT))
        self.start(patch.object(helper.time, 'sleep', self.sleep))
        self.external = self.start(patch.object(helper, 'output', side_effect=self.output))
        self.launch = self.start(patch.object(helper.subprocess, 'run', side_effect=self.acknowledge))
        self.player = Mock()
        self.player.wait.return_value = 0
        self.exec = self.start(patch.object(helper.subprocess, 'Popen', return_value=self.player))

    def start(self, context):
        result = context.start()
        self.addCleanup(context.stop)
        return result

    def sleep(self, seconds):
        self.time += int(seconds * 1000)

    def output(self, args):
        self.time += self.command_delay
        if args[:2] == ['wpctl', 'inspect']:
            return 'id 42, type PipeWire:Interface:Node\n  node.name = "bluez_output.' + self.address + '"'
        if args == ['wpctl', 'get-volume', '42']:
            return self.volume
        self.fail('Unexpected external command: ' + repr(args))

    def acknowledge(self, *args, **kwargs):
        # Simulates the separately tested unit wrapper's receipt, never starts a process.
        helper.receipt(self.result, 'process_started')

    def refused(self, reason, args=None):
        with self.assertRaisesRegex(helper.Refusal, '^' + reason + '$'):
            helper.run(args or self.args)
        self.exec.assert_not_called()

    def test_dispatch_is_bounded_and_passes_the_original_deadline_to_the_unit(self):
        self.assertEqual(helper.run(self.args), 'accepted qp-audio-fixture')
        command = self.launch.call_args.args[0]
        self.assertIn('RuntimeMaxSec=4', command)
        self.assertEqual(command[-7:], ['play', *self.args[1:]])
        self.assertNotIn('set-volume', str(self.external.call_args_list))
        self.exec.assert_not_called()

    def test_unit_checks_again_and_executes_only_the_pinned_output(self):
        helper.receipt(self.result, 'pending')
        self.assertEqual(helper.run(['play', *self.args[1:]]), 'completed qp-audio-fixture')
        self.exec.assert_called_once_with(['pw-play', '--target=bluez_output.' + ADDRESS, str(self.clips / (CLIP + '.wav'))], stdout=helper.subprocess.DEVNULL, stderr=helper.subprocess.DEVNULL)
        self.launch.assert_not_called()

    def test_wrong_speaker_refuses_without_fallback_or_volume_changes(self):
        self.address = '11:22:33:44:55:66'
        self.refused('refused_speaker')
        self.launch.assert_not_called()

    def test_sink_switch_between_dispatch_and_unit_start_refuses(self):
        helper.receipt(self.result, 'pending')
        self.address = '11:22:33:44:55:66'
        self.refused('refused_speaker', ['play', *self.args[1:]])

    def test_volume_drift_or_mute_refuses_without_adjustment(self):
        for volume in ['Volume: 0.36', 'Volume: 1.01', 'Volume: 1.00 [MUTED]']:
            self.volume = volume
            self.refused('refused_volume')
        self.launch.assert_not_called()

    def test_expiry_in_ssh_transit_refuses_before_preparation(self):
        self.time = 101000
        self.refused('refused_expired')
        self.external.assert_not_called()
        self.launch.assert_not_called()

    def test_expiry_while_waiting_for_lock_refuses(self):
        self.start(patch.object(helper.fcntl, 'flock', side_effect=BlockingIOError))
        self.refused('refused_expired')
        self.external.assert_not_called()
        self.launch.assert_not_called()

    def test_preparation_delay_consumes_original_deadline(self):
        self.command_delay = 600
        self.refused('refused_expired')
        self.launch.assert_not_called()

    def test_unit_queueing_delay_refuses_before_playback(self):
        helper.receipt(self.result, 'pending')
        self.time = 101001
        self.refused('refused_expired', ['play', *self.args[1:]])

    def test_pi_reboot_refuses_even_if_monotonic_value_looks_valid(self):
        args = self.args.copy()
        args[5] = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
        self.refused('refused_boot', args)

    def test_missing_arguments_and_excessive_deadline_refuse(self):
        self.refused('bad_arguments', self.args[:4])
        self.refused('refused_deadline', [*self.args[:-1], '106001'])
        self.launch.assert_not_called()

    def test_stop_epoch_orders_launch_on_both_sides_of_systemd(self):
        (self.state / 'audio-stop-epoch').write_text(self.args[2])
        self.refused('refused_stop_epoch')
        helper.receipt(self.result, 'pending')
        self.refused('refused_stop_epoch', ['play', *self.args[1:]])
        self.launch.assert_not_called()

    def test_duplicate_intent_does_not_dispatch_twice(self):
        helper.receipt(self.result, 'pending')
        self.refused('refused_duplicate')
        self.launch.assert_not_called()

    def test_queued_expiry_is_reported_in_the_owned_receipt(self):
        helper.receipt(self.result, 'pending')
        self.time = 101000
        self.refused('refused_expired', ['play', *self.args[1:]])
        self.assertEqual(json.loads(self.result.read_text())['status'], 'refused_expired')

    def test_failed_process_launch_never_publishes_success(self):
        helper.receipt(self.result, 'pending')
        self.exec.side_effect = FileNotFoundError
        with self.assertRaises(FileNotFoundError):
            helper.run(['play', *self.args[1:]])
        self.assertEqual(json.loads(self.result.read_text())['status'], 'playback_error')

    def test_ack_timeout_before_freshness_deadline_is_an_ambiguous_failure(self):
        self.args[-1] = '105000'
        self.launch.side_effect = lambda *args, **kwargs: None
        self.refused('launch_not_acknowledged')

    def test_wall_clock_offsets_do_not_affect_the_boot_clock_deadline(self):
        self.start(patch.object(helper.time, 'time', side_effect=AssertionError('wall clock must not be consulted')))
        self.assertEqual(helper.run(self.args), 'accepted qp-audio-fixture')

    def test_missing_wrapper_ack_is_not_playback_success(self):
        self.launch.side_effect = lambda *args, **kwargs: None
        self.refused('refused_expired')


if __name__ == '__main__':
    unittest.main()
