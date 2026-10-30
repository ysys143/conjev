"""Stream upstream entity bytes through the pinned system curl TLS/HTTP stack.

Credentials travel through an inherited pipe, never argv, files or logs. There
is no configured curl retry or redirect; each CLI request keeps its own record.
"""
from __future__ import annotations

import http.client
import json
import os
import signal
import subprocess
import threading


class CurlTransportError(ConnectionError):
    pass


def quoted(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('\r', '\\r').replace('\n', '\\n') + '"'


class CurlConnection:
    def __init__(self, host, port, timeout=120, *, secure=True):
        self.host, self.port, self.timeout, self.secure = host, port, timeout, secure
        self.headers = []
        self.body = bytearray()
        self.process = None
        self.metrics = {}
        self.exit_code = None
        self.cancelled = False
        self.sock = self  # Recorder cancellation owns this process, not a hidden socket.

    def connect(self):
        pass

    def putrequest(self, method, path, **kwargs):
        self.method, self.path = method, path

    def putheader(self, name, value):
        self.headers.append((name, str(value)))

    def endheaders(self):
        pass

    def send(self, body):
        self.body.extend(body)

    def getresponse(self):
        if self.cancelled:
            raise CurlTransportError('Transfer cancelled before launch')
        scheme = 'https' if self.secure else 'http'
        url = f'{scheme}://{self.host}:{self.port}{self.path}'
        settings = ['url = ' + quoted(url), 'request = ' + quoted(self.method)]
        names = {name.lower() for name, _ in self.headers}
        for name, value in self.headers:
            settings.append('header = ' + quoted(name + ': ' + value))
        # Suppress curl defaults when the originating client did not send them.
        for name in ['Accept', 'User-Agent', 'Content-Type', 'Expect']:
            if name.lower() not in names:
                settings.append('header = ' + quoted(name + ':'))
        config = ('\n'.join(settings) + '\n').encode()
        read_fd, write_fd = os.pipe()
        command = ['/usr/bin/curl', '--silent', '--show-error', '--no-buffer',
                   '--http2' if self.secure else '--http1.1', '--suppress-connect-headers',
                   '--include', '--connect-timeout', str(self.timeout), '--max-time', '600',
                   '--speed-time', str(self.timeout), '--speed-limit', '1',
                   '--config', f'/dev/fd/{read_fd}', '--data-binary', '@-',
                   '--write-out', '%{stderr}\n{"http_code":%{http_code},"size_upload":%{size_upload},"http_version":"%{http_version}","num_connects":%{num_connects},"time_total":%{time_total}}\n']
        try:
            self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, pass_fds=(read_fd,), start_new_session=True)
            if self.cancelled:
                self.shutdown()
        except BaseException:
            os.close(write_fd)
            raise
        finally:
            os.close(read_fd)

        def write_config():
            try:
                with os.fdopen(write_fd, 'wb') as stream:
                    stream.write(config)
            except OSError:
                pass

        writer = threading.Thread(target=write_config, daemon=True)
        writer.start()
        try:
            self.process.stdin.write(self.body)
            self.process.stdin.close()
            self.body.clear()
            response = CurlResponse(self)
        finally:
            writer.join(timeout=5)
        return response

    def collect(self):
        if self.process is None or self.exit_code is not None:
            return
        self.exit_code = self.process.wait(timeout=5)
        diagnostic = self.process.stderr.read().decode(errors='replace')
        for line in diagnostic.splitlines():
            if line.startswith('{'):
                try:
                    self.metrics = json.loads(line)
                except ValueError:
                    pass

    def shutdown(self, how=None):
        self.cancelled = True
        if self.process is not None and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)

    def close(self):
        self.shutdown()
        if self.process is not None:
            try:
                self.collect()
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()
            finally:
                for pipe in [self.process.stdin, self.process.stdout, self.process.stderr]:
                    if pipe is not None and not pipe.closed:
                        pipe.close()


class CurlResponse:
    def __init__(self, connection):
        self.connection = connection
        stream = connection.process.stdout
        while True:
            status_line = stream.readline(65537).decode('iso-8859-1').strip()
            if not status_line.startswith('HTTP/'):
                connection.collect()
                raise CurlTransportError('No upstream response status')
            parts = status_line.split(' ', 2)
            self.status = int(parts[1])
            self.reason = parts[2] if len(parts) == 3 else ''
            self.headers = http.client.parse_headers(stream)
            if self.status >= 200:
                break

    def getheaders(self):
        return list(self.headers.items())

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read1(self, amount):
        chunk = self.connection.process.stdout.read1(amount)
        if not chunk:
            self.connection.collect()
            if self.connection.exit_code != 0:
                raise CurlTransportError('Upstream transfer did not finish')
        return chunk
