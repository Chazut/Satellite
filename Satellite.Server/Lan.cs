using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json.Nodes;

namespace Satellite.Server;

// How the page is opened from another device on the same network (a phone, a tablet): the addresses this PC has there,
// worked out each time they're asked for, so a router handing out another one tomorrow doesn't matter.
public static class Lan
{
    // what SPT_Data/configs/http.json has: the address the server listens on, and its port (set when the server starts)
    public static string Ip = "127.0.0.1";
    public static int Port = 6969;

    // the server listens on more than this PC: every address ("0.0.0.0"), or one of the network's
    public static bool Open
    {
        get
        {
            if (Ip is "0.0.0.0" or "::" or "*" or "+")
            {
                return true;
            }

            return IPAddress.TryParse(Ip, out var only) && !IPAddress.IsLoopback(only);
        }
    }

    // Adapters that are never the home network: virtual switches, VPN and other tunnels, virtual machines.
    private static readonly string[] NotHome =
    [
        "vethernet", "hyper-v", "wsl", "virtualbox", "vmware", "vbox", "tap-", "tap ", "tun", "wireguard", "tailscale",
        "zerotier", "hamachi", "radmin", "vpn", "loopback", "bluetooth", "npcap", "docker", "openvpn", "nordlynx"
    ];

    // This PC's addresses on a home network (10.x, 172.16-31.x, 192.168.x), the ones with a way out to the internet
    // (a gateway: the router) first. Only the one the server listens on when http.json names one.
    public static List<string> Addresses()
    {
        var found = new List<(string Address, bool Gateway)>();
        if (IPAddress.TryParse(Ip, out var only) && only.AddressFamily == AddressFamily.InterNetwork
            && !IPAddress.IsLoopback(only) && !only.Equals(IPAddress.Any))
        {
            return [only.ToString()];
        }

        try
        {
            foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (adapter.OperationalStatus != OperationalStatus.Up
                    || adapter.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel)
                {
                    continue;
                }

                var name = (adapter.Name + " " + adapter.Description).ToLowerInvariant();
                if (NotHome.Any(name.Contains))
                {
                    continue;
                }

                var props = adapter.GetIPProperties();
                var gateway = props.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork
                    && !g.Address.Equals(IPAddress.Any));
                foreach (var unicast in props.UnicastAddresses)
                {
                    var address = unicast.Address;
                    if (address.AddressFamily == AddressFamily.InterNetwork && Private(address))
                    {
                        found.Add((address.ToString(), gateway));
                    }
                }
            }
        }
        catch (Exception)
        {
            // none found, then: the page says how to look it up
        }

        return found.OrderByDescending(f => f.Gateway).Select(f => f.Address).Distinct().ToList();
    }

    private static bool Private(IPAddress address)
    {
        var b = address.GetAddressBytes();
        return b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168);
    }

    // for the page: {"open":true,"port":6969,"addrs":["192.168.1.20"]}
    public static string Json()
    {
        var list = new JsonArray();
        foreach (var address in Open ? Addresses() : [])
        {
            list.Add(address);
        }

        return new JsonObject { ["open"] = Open, ["port"] = Port, ["addrs"] = list }.ToJsonString();
    }
}
