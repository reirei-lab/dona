"""隔離fixtureで既存offline preserve世代のcontrol更新を検証する。"""
import copy
import json
import os
from pathlib import Path
import plistlib
import socket
import subprocess
import sys
import tempfile

helper = Path(__file__).resolve().parents[2] / 'scripts/validate-generation-install-target.py'
with tempfile.TemporaryDirectory(dir="/private/tmp" if sys.platform == "darwin" else "/tmp") as temp:
    home = Path(temp).resolve()
    root = home / '.dona/g/offline-aaaaaaaaaaaa'
    data = home / '.dona/g/offline-bbbbbbbbbbbb'
    launch = home / 'LaunchAgents'
    rendered = home / 'rendered'
    sha = 'c' * 40
    for folder in [root, data, launch, rendered, root/'control', root/'control/updater', root/'config', root/'logs', root/'run', root/'runtime/releases'/sha, data/'run']:
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        folder.chmod(0o700)
    (root/'runtime/current').symlink_to(root/'runtime/releases'/sha)
    def write(file, value):
        file.write_bytes(value)
        file.chmod(0o600)
    def plist(file, value):
        write(file, plistlib.dumps(value))
    write(root/'control/updater.sqlite3', b'fixture')
    write(data/'dona.sqlite3', b'fixture')
    socks = []
    for name in ['d.sock', 's.sock']:
        sock = socket.socket(socket.AF_UNIX)
        sock.bind(str(data/'run'/name))
        (data/'run'/name).chmod(0o600)
        socks.append(sock)
    policy = dict(control_root=str(root/'control'), config_root=str(root/'config'), release_root=str(root/'runtime/releases'), current_pointer=str(root/'runtime/current'), dispatcher_socket=str(data/'run/d.sock'), slack_socket=str(data/'run/s.sock'), dispatcher_internal_token_file=str(root/'control/dispatcher.token'))
    write(root/'control/policy.json', json.dumps(policy).encode())
    shared = dict(DONA_DATABASE_PATH=str(data/'dona.sqlite3'), DONA_SOCKET_PATH=policy['dispatcher_socket'], SLACK_HEALTH_SOCKET_PATH=policy['slack_socket'], DONA_UPDATE_INTERNAL_TOKEN_PATH=policy['dispatcher_internal_token_file'], DONA_RELEASE_MANIFEST_PATH=str(root/'runtime/current/release-manifest.json'))
    installed = {}
    for label, program in [('dev.dona.updater', root/'control/updater/dist/cli.js'), ('dev.dona.dispatcher', root/'runtime/current/dispatcher/dist/cli.js'), ('dev.dona.slack-adapter', root/'runtime/current/sources/slack/dist/index.js')]:
        component = 'dispatcher' if label == 'dev.dona.dispatcher' else 'slack'
        env = dict(shared, DOTENV_CONFIG_PATH=str(root/'config'/(component+'.env')))
        if label.endswith('updater'):
            env = dict(DONA_UPDATE_POLICY_PATH=str(root/'control/policy.json'), DONA_UPDATER_BUILD_SHA=sha)
        elif label.endswith('dispatcher'):
            env['DONA_UPDATER_SOCKET_PATH'] = str(root/'control/updater.sock')
            for key, suffix in [('DONA_RESULTS_DIR','results'), ('DONA_JOB_RESULTS_DIR','job-results'), ('DONA_JOB_PROGRESS_DATABASE_PATH','job-progress.sqlite3'), ('DONA_UPDATE_NOTIFICATION_DATABASE_PATH','update-notifications.sqlite3')]:
                env[key] = str(data/suffix)
        if not label.endswith('updater'):
            write(root/'config'/(component+'.env'), ''.join(f"{k}='{v}'\n" for k,v in env.items()).encode())
        args = ['/usr/bin/node', str(program)] + ([] if label.endswith('adapter') else ['serve'])
        installed[label] = dict(Label=label, ProgramArguments=args, EnvironmentVariables=env)
        plist(launch/(label+'.plist'), installed[label])
    def candidates():
        for label, value in installed.items():
            candidate = copy.deepcopy(value)
            candidate['EnvironmentVariables'] = {k:v.replace(str(data), str(root)) for k,v in candidate['EnvironmentVariables'].items()}
            plist(rendered/(label+'.plist'), candidate)
        write(rendered/'policy.json', json.dumps(dict(policy, dispatcher_socket=str(root/'run/d.sock'), slack_socket=str(root/'run/s.sock'), task_generation_update={'mode':'forward_only','schema':4,'task_execution_version':1})).encode())
    def run(success):
        result = subprocess.run(['/usr/bin/python3', str(helper), str(root), str(rendered), str(launch), '--upgrade-control'], env=dict(os.environ, HOME=str(home)), capture_output=True)
        assert (result.returncode == 0) == success, result.stderr.decode()
    candidates(); run(True)
    actual = json.loads((rendered/'policy.json').read_text())
    assert actual['dispatcher_socket'] == policy['dispatcher_socket']
    assert actual['slack_socket'] == policy['slack_socket']
    assert actual['task_generation_update']['mode'] == 'forward_only'
    assert 'signed_host' not in actual
    for label in ['dev.dona.dispatcher', 'dev.dona.slack-adapter']:
        actual = plistlib.loads((rendered/(label+'.plist')).read_bytes())
        assert actual == installed[label]
    # Config drift, wrong data scope, symlink DB and policy/plist disagreement fail closed.
    config = root/'config/dispatcher.env'; original = config.read_bytes()
    write(config, original.replace(str(data/'dona.sqlite3').encode(), str(root/'dona.sqlite3').encode()))
    candidates(); before = (rendered/'dev.dona.dispatcher.plist').read_bytes(); run(False)
    assert (rendered/'dev.dona.dispatcher.plist').read_bytes() == before
    write(config, original)
    bad = dict(policy, dispatcher_socket=str(home/'foreign/run/d.sock'))
    write(root/'control/policy.json', json.dumps(bad).encode()); run(False)
    write(root/'control/policy.json', json.dumps(policy).encode())
    db = data/'dona.sqlite3'; db.rename(data/'real.sqlite3'); db.symlink_to(data/'real.sqlite3'); run(False); db.unlink(); (data/'real.sqlite3').rename(db)
    drift = copy.deepcopy(installed['dev.dona.slack-adapter']); drift['EnvironmentVariables']['DONA_SOCKET_PATH'] = str(root/'run/d.sock')
    plist(launch/'dev.dona.slack-adapter.plist', drift); run(False)
    for sock in socks: sock.close()
