using System.Reflection;
using Microsoft.AspNetCore.Http;
using SPTarkov.Reflection.Patching;

namespace Satellite.Server;

// SPT writes "[Client Request] <path>" to the console for every request (logRequests in http.json). The game plugin
// reports several times a second during a raid, which would bury everything else. This skips that line for the
// map's own paths, and for the map's own questions to Better Flea (FleaPrices, marked by a header). Every other
// request is still logged.
public class QuietRequests : AbstractPatch
{
    protected override MethodBase GetTargetMethod() =>
        AppDomain.CurrentDomain.GetAssemblies()
            .Select(assembly => assembly.GetType("SPTarkov.Server.Middleware.SptLoggerMiddleware", false))
            .FirstOrDefault(type => type != null)
            ?.GetMethod("LogRequest", BindingFlags.Instance | BindingFlags.Public)
        ?? throw new MissingMethodException("SptLoggerMiddleware", "LogRequest");

    [PatchPrefix]
    public static bool Prefix(HttpContext context) =>
        LiveMapRoute.RootOf(context.Request.Path.Value ?? "") == null && !context.Request.Headers.ContainsKey(LiveMapRoute.QuietHeader);
}
