import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none bg-[url('/grid.svg')] opacity-10" />
      
      <Card className="w-full max-w-md bg-card/50 backdrop-blur border-border/50 shadow-2xl">
        <CardContent className="pt-6 flex flex-col items-center text-center">
          <div className="mb-4 rounded-full bg-destructive/10 p-4 border border-destructive/20 shadow-[0_0_20px_-5px_rgba(239,68,68,0.3)]">
            <AlertTriangle className="h-12 w-12 text-destructive" />
          </div>
          <h1 className="text-4xl font-bold font-display uppercase tracking-widest text-foreground mb-2">404</h1>
          <p className="text-xl font-medium text-muted-foreground mb-6">
            Sector Not Found
          </p>
          <p className="text-sm text-muted-foreground mb-8">
            The coordinates you are looking for do not exist in the current grid sector.
          </p>

          <Link href="/">
            <Button className="w-full bg-primary text-black font-bold hover:bg-primary/90">
              Return to Command Center
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
