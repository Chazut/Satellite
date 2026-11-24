using EFT.Interactive;
using UnityEngine;

namespace Satellite.Shared
{
    internal static class ExitPlace
    {
        // Where an extract is: the middle of the ground that counts as it (its trigger), not where its object stands.
        // Some stand well off it (Woods' RUAF Gate, 30 m off the road the gate is on). Its object's place when it has
        // no trigger to go by.
        internal static Vector3 Of(Component exit)
        {
            if (exit == null)
            {
                return Vector3.zero;
            }

            foreach (var trigger in exit.GetComponents<Collider>())
            {
                if (trigger != null && trigger.isTrigger && trigger.bounds.size.sqrMagnitude > 0.01f)
                {
                    return trigger.bounds.center;
                }
            }

            return exit.transform.position;
        }
    }
}
