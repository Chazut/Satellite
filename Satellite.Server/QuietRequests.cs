using System.Reflection;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using SPTarkov.DI.Annotations;
using SPTarkov.Server.Core.Helpers.Server;
using SPTarkov.Server.Core.Servers;

namespace Satellite.Server;

// SPT writes "[Client Request] <path>" to the server window for every request, and a page loading the map asks for
// each of its tiles, so one look at the map would fill the window. This sends the map's own requests (/satellite/...)
// to SPT's HttpServer the way SPT's pipeline does, only without passing the request log on the way. Every other
// request (the game's, other mods') never comes here and goes through SPT exactly as before, and SPT's settings
// (http.json's logRequests) are never changed.
//
// ASP.NET puts what a startup filter adds in front of the server's own pipeline. Nothing is patched.
// config.jsonc's server.quietLogs set false leaves the map's requests in the log.
[Injectable(InjectionType.Singleton)]
public class QuietRequests(ModHelper modHelper) : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            var folder = modHelper.GetAbsolutePathToModFolder(Assembly.GetExecutingAssembly());
            if (LiveMapRoute.QuietLogs(Path.Combine(folder, "config.jsonc")))
            {
                app.MapWhen(context => context.Request.Path.StartsWithSegments(LiveMapRoute.Root), map =>
                {
                    // the plugin's link is a WebSocket (api/link/...)
                    map.UseWebSockets();
                    map.Run(context => context.RequestServices.GetRequiredService<HttpServer>()
                        .HandleRequestAsync(context, NotFound, context.RequestAborted));
                });
            }

            next(app);
        };
    }

    private static Task NotFound(HttpContext context)
    {
        context.Response.StatusCode = 404;
        return Task.CompletedTask;
    }
}
