"""Run one test-owned command in a PTY; relay input and answer terminal queries."""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
stopping = False


def stop(_signum, _frame):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
inputs = [master, sys.stdin.fileno()]
tail = b""
status = None
try:
    while not stopping:
        ready, _, _ = select.select(inputs, [], [], 0.1)
        for descriptor in ready:
            try:
                chunk = os.read(descriptor, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if not chunk:
                inputs.remove(descriptor)
                if descriptor == master:
                    stopping = True
                continue
            if descriptor != master:
                os.write(master, chunk)
                continue
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            tail += chunk
            # Keep incomplete CSI sequences across reads.
            for query, answer in [(b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[c", b"\x1b[?1;2c"), (b"\x1b[>c", b"\x1b[>0;0;0c")]:
                while query in tail:
                    os.write(master, answer)
                    tail = tail.replace(query, b"", 1)
            tail = tail[-8:]
        ended, result = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = result
            stopping = True
finally:
    # PTYのEOFとwaitpidで回収可能になる時点には短い差がある。
    deadline = time.monotonic() + 0.3
    while status is None and time.monotonic() < deadline:
        ended, result = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = result
            break
        time.sleep(0.01)
    if status is None:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            ended, result = os.waitpid(pid, os.WNOHANG)
            if ended:
                status = result
                break
            time.sleep(0.05)
        if status is None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
    os.close(master)
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
