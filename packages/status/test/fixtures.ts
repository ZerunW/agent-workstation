/** Realistic /proc and /sys snippets (trimmed from a small Linux server). */

// busy = user+nice+system+irq+softirq+steal; idle = idle+iowait
export const PROC_STAT_A = `cpu  1000 0 500 8000 500 0 0 0 0 0
cpu0 600 0 200 3000 200 0 0 0 0 0
cpu1 400 0 300 5000 300 0 0 0 0 0
intr 123456 0 0
ctxt 987654
btime 1700000000
processes 4321
`;

// Versus A: total busy +400 of +1400 total (28.57 %); cpu0 busy +300 of +500 (60 %); cpu1 +100 of +900 (11.11 %)
export const PROC_STAT_B = `cpu  1300 0 600 8900 600 0 0 0 0 0
cpu0 800 0 300 3100 300 0 0 0 0 0
cpu1 500 0 300 5800 300 0 0 0 0 0
intr 223456 0 0
ctxt 1987654
btime 1700000000
processes 4400
`;

export const MEMINFO = `MemTotal:        8123456 kB
MemFree:          812340 kB
MemAvailable:    5123456 kB
Buffers:          123456 kB
Cached:          3456789 kB
SwapCached:            0 kB
SwapTotal:       4061724 kB
SwapFree:        4000000 kB
HugePages_Total:       0
HugePages_Free:        0
Hugepagesize:       2048 kB
`;

export const NET_DEV_A = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  500000    4000    0    0    0     0          0         0   500000    4000    0    0    0     0       0          0
enp1s0: 1000000   9000    0    0    0     0          0       120  200000    5000    0    0    0     0       0          0
`;

// +5_000_000 rx and +1_000_000 tx over 10 s -> 500 kB/s down, 100 kB/s up
export const NET_DEV_B = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  600000    4100    0    0    0     0          0         0   600000    4100    0    0    0     0       0          0
enp1s0:6000000  12000    0    0    0     0          0       130 1200000    7000    0    0    0     0       0          0
`;

export const DISKSTATS_A = ` 259       0 nvme0n1 1000 20 80000 500 500 10 40000 300 0 700 800 0 0 0 0 0 0
 259       1 nvme0n1p1 900 20 70000 400 400 10 30000 200 0 600 700 0 0 0 0 0 0
   7       0 loop0 10 0 80 1 0 0 0 0 0 4 1 0 0 0 0 0 0
`;

// +20480 sectors read (10 MiB), +40960 sectors written (20 MiB), +2000 ms busy over 10 s
export const DISKSTATS_B = ` 259       0 nvme0n1 1500 20 100480 600 800 10 80960 400 0 2700 900 0 0 0 0 0 0
 259       1 nvme0n1p1 900 20 70000 400 400 10 30000 200 0 600 700 0 0 0 0 0 0
   7       0 loop0 10 0 80 1 0 0 0 0 0 4 1 0 0 0 0 0 0
`;

export const LOADAVG = "0.52 0.41 0.30 2/613 12345\n";
export const UPTIME = "93784.25 361822.01\n";
export const ZRAM_MM_STAT = "  104857600  31457280  36700160        0  41943040        0        0        0\n";
