using System.Collections;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using Satellite.Server;
using SPTarkov.Common.Models.Logging;

// dotnet run --project tests/ReplayLoading -p:Recording=true
const string loading = """{"t":"full","rid":"woods","raid":true,"loc":"Woods","go":0}""";
const string playing = """{"t":"full","rid":"woods","raid":true,"loc":"Woods","markers":[{"c":"Main Player","sd":"Usec"}]}""";
const string movement = """{"t":"fast","positions":[[7,1,2,3]]}""";
const string exit = """{"t":"full","rid":"woods","raid":false,"ev":[{"k":"end","d":{"st":"Survived"}}]}""";

void Check(bool pass, string message)
{
    if (!pass) throw new InvalidOperationException(message);
}

void WaitFor(Func<bool> condition, string message) =>
    Check(SpinWait.SpinUntil(condition, TimeSpan.FromSeconds(10)), message);

string[] ReadPacked(string path)
{
    using var gzip = new GZipStream(File.OpenRead(path), CompressionMode.Decompress);
    using var reader = new StreamReader(gzip);
    return reader.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries);
}

var root = Directory.CreateTempSubdirectory("satellite-replay-test-");
try
{
    var woods = new RecorderFixture(root.FullName, "000001");
    woods.Record(loading);
    var original = woods.Active;
    woods.Age(87_000, 87_000);
    woods.CheckTimeout();
    Check(original != null && woods.Active == original, "The 87-second Woods load lost its recording.");
    woods.Record(movement);
    Check(woods.Lead == -1, "Position data incorrectly ended the loading phase.");
    woods.Record(playing);
    Check(woods.Lead >= 87_000, "The replay did not retain the Woods loading offset.");
    woods.SendComet(1);
    woods.Record(movement);
    woods.Record(exit);
    var file = woods.FileBase;
    WaitFor(() => File.Exists(file + ".rec.gz") && !File.Exists(file + ".rec"), "The completed Woods raid was not packed.");
    var frames = ReadPacked(file + ".rec.gz").Select(line => line.Split('\t', 2)[1]);
    Check(frames.SequenceEqual(new[] { loading, movement, playing, movement, exit }), "Recorded frames changed or are out of order.");
    Check(woods.List()["raids"]!.AsArray().Single()?["exit"]?.GetValue<string>() == "Survived", "Woods is missing its outcome in History.");
    woods.SendComet(2);
    Check(ReadPacked(file + ".comet.gz").Length == 2, "Valid late COMET events were lost.");
    Console.WriteLine("PASS Woods loading silence, replay order, history and late COMET events");

    var abandoned = new RecorderFixture(root.FullName, "000002");
    abandoned.Record(loading);
    abandoned.SendComet(1);
    file = abandoned.FileBase;
    abandoned.Age(601_000, 601_000);
    abandoned.CheckTimeout();
    Check(abandoned.Active == null, "An abandoned load never timed out.");
    WaitFor(() => !File.Exists(file + ".rec") && !File.Exists(file + ".comet.gz"), "An abandoned load left replay files behind.");
    abandoned.SendComet(2);
    Check(!File.Exists(file + ".comet.gz"), "An abandoned load recreated its COMET file.");
    abandoned.Record(playing);
    Check(abandoned.Active != null && abandoned.Lead == 0, "The same raid could not resume after loading timed out.");
    abandoned.Record(exit);
    WaitFor(() => !File.Exists(abandoned.FileBase + ".rec"), "The short resumed raid was not discarded.");
    Console.WriteLine("PASS abandoned load and same-ID restart");

    var active = new RecorderFixture(root.FullName, "000003");
    active.Record(playing);
    active.Age(100_000, 29_000);
    active.CheckTimeout();
    Check(active.Active != null, "An active raid was closed before 30 seconds.");
    active.Age(3_000, 3_000);
    active.CheckTimeout();
    Check(active.Active == null, "An active raid stayed open after 30 seconds of silence.");
    active.Record(playing);
    Check(active.Active == null, "A late host report reopened a finished raid.");
    WaitFor(() => File.Exists(active.FileBase + ".rec.gz") && !File.Exists(active.FileBase + ".rec"), "A real disconnected raid was lost.");
    Console.WriteLine("PASS normal disconnect and duplicate host reports");

    var quit = new RecorderFixture(root.FullName, "000004");
    quit.Record(loading);
    quit.Age(90_000, 90_000);
    quit.Record(loading);
    quit.SendComet(1);
    quit.Record(exit);
    file = quit.FileBase;
    WaitFor(() => !File.Exists(file + ".rec") && !File.Exists(file + ".comet.gz"), "An explicit exit during loading left replay files behind.");
    quit.SendComet(2);
    quit.Record(playing);
    Check(quit.Active == null && !File.Exists(file + ".comet.gz") && !File.Exists(file + ".json"), "A discarded raid was resurrected.");
    Console.WriteLine("PASS explicit exit during loading and late packets");
}
finally
{
    root.Delete(true);
}

// Drive the installed server's recorder without a running SPT instance. Advance only
// its monotonic timestamps so the real watchdog and file handling run without sleeps.
sealed class RecorderFixture
{
    const BindingFlags Members = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
    static readonly Type Route = typeof(LiveMapRoute);
    readonly LiveMapRoute route = new(DispatchProxy.Create<ISptLogger<LiveMapRoute>, SilentLog>(), null!, null!, null!, null!, null!, null!);
    readonly object session;
    readonly string id;
    readonly string folder;
    public string FileBase { get; private set; } = "";
    public object? Active => ((IDictionary)Route.GetField("_recording", Members)!.GetValue(route)!)[id];
    public long Lead => (long)Active!.GetType().GetField("Lead")!.GetValue(Active)!;

    public RecorderFixture(string root, string id)
    {
        this.id = id;
        folder = Path.Combine(root, id);
        Route.GetField("_folder", Members)!.SetValue(route, folder);
        Route.GetField("_history", Members)!.SetValue(route, (true, 30));
        Route.GetField("_cometSettings", Members)!.SetValue(route, (true, false, 1_000_000L));
        var type = Route.GetNestedType("Session", BindingFlags.NonPublic)!;
        session = Activator.CreateInstance(type, [id])!;
    }

    public void Record(string report)
    {
        Call("Record", session, report);
        if (Active is { } rec)
        {
            FileBase = Path.Combine(folder, "history", (string)rec.GetType().GetProperty("Id")!.GetValue(rec)!);
        }
    }

    public void Age(int sinceBegin, int sinceLast)
    {
        var rec = Active ?? throw new InvalidOperationException("Missing active recording");
        foreach (var (name, age) in new[] { ("BeganTick", sinceBegin), ("LastTick", sinceLast) })
        {
            var field = rec.GetType().GetField(name)!;
            field.SetValue(rec, (long)field.GetValue(rec)! - age);
        }
    }

    public void CheckTimeout() => Call("EndQuiet");
    public JsonNode List() => JsonNode.Parse((string)Call("HistoryList")!)!;
    public void SendComet(int time) => Call("CometTaken", id, Encoding.UTF8.GetBytes(
        """{"rid":"woods","ev":[{"p":"bot","f":"T04","s":"start","d":{},"t":""" + time + "}]}"));
    object? Call(string method, params object[] args) => Route.GetMethod(method, Members)!.Invoke(route, args);
}

public class SilentLog : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) =>
        method!.ReturnType.IsValueType && method.ReturnType != typeof(void) ? Activator.CreateInstance(method.ReturnType) : null;
}
