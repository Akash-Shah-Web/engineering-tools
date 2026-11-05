/* LoopForge C test harness.
 * Built by tests/c_codegen.test.js against each generated header.
 *   ./harness vec  < vectors.txt   : open-loop vectors "r y" -> u (one per line)
 *   ./harness cl                   : closed loop with the sampled plant from plant.h
 * Compile with -DLF_FIXED for the Q16.16 header, otherwise the float header.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#ifdef LF_FIXED
#include "loopforge_pid_q16.h"
#else
#include "loopforge_pid.h"
#endif
#include "plant.h"

#ifdef LF_FIXED
static int32_t to_q16(double x) { return (int32_t)floor(x * 65536.0 + 0.5); }
typedef lf_pid_q16_t ctl_t;
static void ctl_init(ctl_t *s, double y0, double u0) { lf_pid_q16_init(s, to_q16(y0), to_q16(u0)); }
static double ctl_step(ctl_t *s, double r, double y, long *raw)
{
    int32_t u = lf_pid_q16_step(s, to_q16(r), to_q16(y));
    *raw = (long)u;
    return (double)u / 65536.0;
}
#else
typedef lf_pid_t ctl_t;
static void ctl_init(ctl_t *s, double y0, double u0) { lf_pid_init(s, (lf_real)y0, (lf_real)u0); }
static double ctl_step(ctl_t *s, double r, double y, long *raw)
{
    *raw = 0;
    return (double)lf_pid_step(s, (lf_real)r, (lf_real)y);
}
#endif

int main(int argc, char **argv)
{
    ctl_t pid;
    long raw;
    if (argc > 1 && strcmp(argv[1], "vec") == 0) {
        double r, y, y0, u0;
        if (scanf("%lf %lf", &y0, &u0) != 2) return 2;
        ctl_init(&pid, y0, u0);
        while (scanf("%lf %lf", &r, &y) == 2) {
            double u = ctl_step(&pid, r, y, &raw);
            printf("%.17g %ld\n", u, raw);
        }
        return 0;
    }
    {
        static double w[PL_N];
        double x[2] = {0.0, 0.0};
        int k;
        ctl_init(&pid, PL_Y0, PL_UPRE);
        for (k = 0; k < PL_N; k++) {
            double t = k * PL_TS;
            double y = PL_Y0 + (PL_ORDER == 2 ? x[1] : x[0]);
            double r = t >= PL_TSTEP ? PL_R1 : PL_R0;
            double du = t >= PL_TDIST ? PL_DU : 0.0;
            double u = ctl_step(&pid, r, y, &raw);
            double wa, wb, x0;
            w[k] = u + du - PL_UPRE;
            wa = (k - PL_D >= 0) ? w[k - PL_D] : 0.0;
            wb = (k - PL_D - 1 >= 0) ? w[k - PL_D - 1] : 0.0;
            printf("%d %.17g %.17g %ld\n", k, y, u, raw);
            x0 = x[0];
            x[0] = PL_PHI00 * x0 + PL_G0_0 * wa + PL_G1_0 * wb;
            if (PL_ORDER == 2)
                x[1] = PL_PHI10 * x0 + PL_PHI11 * x[1] + PL_G0_1 * wa + PL_G1_1 * wb;
        }
    }
    return 0;
}
