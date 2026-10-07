#!/usr/bin/env python3
"""Validate an explicitly selected installed generation before staging or control upgrade."""
import inspect
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import stat
import sys


def require(condition):
    if not condition:
        raise RuntimeError(f'selected generation check failed at {inspect.currentframe().f_back.f_lineno}')


def regular(path):
    require(path.is_file() and not path.is_symlink())
    return path


def main():
    root, rendered, launch_agents = map(Path, sys.argv[1:4])
    mode = sys.argv[4]
    require(mode in ('--upgrade-control', '--stage-recovery'))
    generation_parent = Path.home() / '.dona' / 'g'
    offline = re.fullmatch(r'offline-[0-9a-f]{12}', root.name) is not None
    require(root.parent == generation_parent and (offline or re.fullmatch(r'[0-9a-f]{12}', root.name)))
    require(root.is_dir() and not root.is_symlink())
    for suffix in ('control', 'control/updater', 'runtime', 'runtime/releases', 'config', 'logs', 'run'):
        entry = root / suffix
        require(entry.is_dir() and not entry.is_symlink())
    control = root / 'control'
    policy = json.loads(regular(control / 'policy.json').read_text())
    data_root = root
    if offline:
        # Preserve updates intentionally retain the original data generation.
        # The installed policy, both plists and both private dotenv files must agree.
        require(mode == '--upgrade-control')
        def private(entry, directory=False):
            info = entry.lstat()
            require(entry.resolve() == entry and info.st_uid == os.getuid())
            require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            require(info.st_mode & 0o077 == 0)
            if not directory:
                require(info.st_nlink == 1)
        private(root, True)
        private(control, True)
        private(control / 'policy.json')
        data_root = Path(policy.get('dispatcher_socket', '')).parent.parent
        require(data_root.parent == generation_parent and re.fullmatch(r'(?:offline-)?[0-9a-f]{12}', data_root.name))
        private(data_root, True)
        private(data_root / 'run', True)
        private(data_root / 'dona.sqlite3')
        require(policy.get('slack_socket') == str(data_root / 'run/s.sock'))
        bound = {'DONA_DATABASE_PATH': data_root / 'dona.sqlite3',
                 'DONA_SOCKET_PATH': data_root / 'run/d.sock',
                 'SLACK_HEALTH_SOCKET_PATH': data_root / 'run/s.sock'}
        for component, label in [('dispatcher', 'dev.dona.dispatcher'), ('slack', 'dev.dona.slack-adapter')]:
            config_file = root / 'config' / (component + '.env')
            private(config_file)
            config = {}
            for line in config_file.read_text().splitlines():
                if not line.strip() or line.lstrip().startswith('#'):
                    continue
                key, sep, raw = line.partition('=')
                if key not in bound:
                    continue
                require(sep and key not in config)
                values = shlex.split(raw, comments=True)
                require(len(values) == 1)
                config[key] = values[0]
            installed_file = launch_agents / (label + '.plist')
            private(installed_file)
            env = plistlib.loads(installed_file.read_bytes()).get('EnvironmentVariables', {})
            require(all(config.get(k) == str(v) and env.get(k) == str(v) for k, v in bound.items()))
        for socket in (data_root / 'run/d.sock', data_root / 'run/s.sock'):
            info = socket.lstat()
            require(socket.resolve() == socket and stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0)
    expected = {
        'control_root': control,
        'config_root': root / 'config',
        'release_root': root / 'runtime/releases',
        'current_pointer': root / 'runtime/current',
        'dispatcher_socket': data_root / 'run/d.sock',
        'slack_socket': data_root / 'run/s.sock',
        'dispatcher_internal_token_file': control / 'dispatcher.token',
    }
    require(all(policy.get(key) == str(value) for key, value in expected.items()))
    current = root / 'runtime/current'
    require(current.is_symlink())
    active = current.resolve(strict=True)
    require(active.parent == root / 'runtime/releases' and re.fullmatch(r'[0-9a-f]{40}', active.name))
    old_updater_sha = None
    for label in ('dev.dona.updater', 'dev.dona.dispatcher'):
        installed = plistlib.loads(regular(launch_agents / (label + '.plist')).read_bytes())
        candidate_file = rendered / (label + '.plist')
        candidate = plistlib.loads(regular(candidate_file).read_bytes())
        require(installed.get('Label') == label and candidate.get('Label') == label)
        argv = installed.get('ProgramArguments', [])
        expected_program = control / 'updater/dist/cli.js' if label.endswith('updater') else current / 'dispatcher/dist/cli.js'
        if label == 'dev.dona.dispatcher' and policy.get('signed_host') is not None and (active / 'signed-host/DonaDispatcher.app').is_dir():
            require(argv == [str(current / 'signed-host/DonaDispatcher.app/Contents/MacOS/DonaDispatcher'), 'serve'])
        else:
            require(len(argv) == 3 and argv[1] == str(expected_program) and argv[2] == 'serve')
        env = installed.get('EnvironmentVariables', {})
        require(isinstance(env, dict))
        if label.endswith('updater'):
            require(env.get('DONA_UPDATE_POLICY_PATH') == str(control / 'policy.json'))
            require(re.fullmatch(r'[0-9a-f]{40}', env.get('DONA_UPDATER_BUILD_SHA', '')))
            old_updater_sha = env['DONA_UPDATER_BUILD_SHA']
        else:
            require(env.get('DONA_UPDATER_SOCKET_PATH') == str(control / 'updater.sock'))
            require(env.get('DONA_UPDATE_INTERNAL_TOKEN_PATH') == str(control / 'dispatcher.token'))
            require(env.get('DONA_SOCKET_PATH') == str(data_root / 'run/d.sock'))
            require(env.get('SLACK_HEALTH_SOCKET_PATH') == str(data_root / 'run/s.sock'))
            require(env.get('DONA_DATABASE_PATH') == str(data_root / 'dona.sqlite3'))
            require(env.get('DONA_RELEASE_MANIFEST_PATH') == str(current / 'release-manifest.json'))
            for key, suffix in {
                'DONA_RESULTS_DIR': 'results',
                'DONA_JOB_RESULTS_DIR': 'job-results',
                'DONA_JOB_PROGRESS_DATABASE_PATH': 'job-progress.sqlite3',
                'DONA_UPDATE_NOTIFICATION_DATABASE_PATH': 'update-notifications.sqlite3',
                'DOTENV_CONFIG_PATH': 'config/dispatcher.env',
            }.items():
                require(env.get(key) == str((root if key == 'DOTENV_CONFIG_PATH' else data_root) / suffix))
            # Keep generation-specific environment that the generic template does not describe.
            updated = dict(env)
            updated.update(candidate['EnvironmentVariables'])
            candidate['EnvironmentVariables'] = updated
            if offline:
                for key in ('DONA_DATABASE_PATH', 'DONA_SOCKET_PATH', 'SLACK_HEALTH_SOCKET_PATH', 'DONA_RESULTS_DIR', 'DONA_JOB_RESULTS_DIR', 'DONA_JOB_PROGRESS_DATABASE_PATH', 'DONA_UPDATE_NOTIFICATION_DATABASE_PATH'):
                    candidate['EnvironmentVariables'][key] = env[key]
            dispatcher_candidate = candidate
    slack = plistlib.loads(regular(launch_agents / 'dev.dona.slack-adapter.plist').read_bytes())
    require(slack.get('Label') == 'dev.dona.slack-adapter')
    slack_argv = slack.get('ProgramArguments', [])
    require(len(slack_argv) == 2 and slack_argv[1] == str(current / 'sources/slack/dist/index.js'))
    slack_env = slack.get('EnvironmentVariables', {})
    require(isinstance(slack_env, dict))
    require(slack_env.get('DONA_SOCKET_PATH') == str(data_root / 'run/d.sock'))
    require(slack_env.get('SLACK_HEALTH_SOCKET_PATH') == str(data_root / 'run/s.sock'))
    require(slack_env.get('DOTENV_CONFIG_PATH') == str(root / 'config/slack.env'))
    require(slack_env.get('DONA_UPDATE_INTERNAL_TOKEN_PATH') == str(control / 'dispatcher.token'))
    require(slack_env.get('DONA_RELEASE_MANIFEST_PATH') == str(current / 'release-manifest.json'))
    receipt = control / 'control-plane-receipt.json'
    if receipt.exists():
        regular(receipt)
    database = control / 'updater.sqlite3'
    require(regular(database))
    if mode == '--upgrade-control':
        candidate_file = rendered / 'dev.dona.dispatcher.plist'
        candidate_file.write_bytes(plistlib.dumps(dispatcher_candidate))
        os.chmod(candidate_file, 0o600)
        if offline:
            candidate_policy = json.loads((rendered / 'policy.json').read_text())
            for key in ('dispatcher_socket', 'slack_socket'):
                candidate_policy[key] = policy[key]
            (rendered / 'policy.json').write_text(json.dumps(candidate_policy) + '\n')
            slack_candidate_file = rendered / 'dev.dona.slack-adapter.plist'
            candidate_slack = plistlib.loads(slack_candidate_file.read_bytes())
            merged_env = dict(slack_env)
            merged_env.update(candidate_slack['EnvironmentVariables'])
            for key in ('DONA_DATABASE_PATH', 'DONA_SOCKET_PATH', 'SLACK_HEALTH_SOCKET_PATH'):
                merged_env[key] = slack_env[key]
            candidate_slack['EnvironmentVariables'] = merged_env
            slack_candidate_file.write_bytes(plistlib.dumps(candidate_slack))
    print(old_updater_sha)


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 5)
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
